/**
 * governance-drift.processor.ts — BullMQ processor for governance-drift jobs.
 *
 * Ports the `scripts/governance-drift.js` check loop into a standalone,
 * idempotent NestJS processor.
 *
 * Per-cycle algorithm (legacy parity — DoD §I):
 *   1. Skip if `PAPER_MODE === true` (parity with `entrypoint.sh:779`).
 *   2. Loop over ACTIVE_CHAINS:
 *      a. For EVM chains: call `SafeTxServiceAdapter.getSafeInfo()` and compare
 *         against expected config read from ConfigService fields.
 *      b. For Solana: call `SquadsRpcAdapter.getMultisigInfo()` and compare
 *         against EXPECTED_SQUADS_MEMBERS / EXPECTED_SQUADS_THRESHOLD
 *         (SDK port complete — entrypoint.sh:run_governance_drift_loop disabled).
 *   3. On drift detected: call `notificationsService.sendCriticalAlert({ type: 'rug_warning' ... })`.
 *   4. Always write `systemService.setMeta('last_governance_drift_at', now)`.
 *
 * Idempotency (DoD §E):
 *   Running this processor twice with identical on-chain state leaves the DB
 *   identical (only `last_governance_drift_at` advances — it is a timestamp,
 *   not an accumulating value).
 *
 * Config access (ADR-0026 — per-field):
 *   - `PAPER_MODE`
 *   - `ACTIVE_CHAINS`
 *   - `EXPECTED_SAFE_OWNERS_<CHAIN>`, `EXPECTED_SAFE_THRESHOLD_<CHAIN>`,
 *     `EXPECTED_SAFE_MODULES_<CHAIN>` (per chain, runtime-keyed — ADR-0026 §4 exception)
 *   - `SAFE_ADDRESS_<CHAIN>` (resolved via chain.safe.addressEnv)
 *   - `EXPECTED_SQUADS_MEMBERS`, `EXPECTED_SQUADS_THRESHOLD`
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no process.env reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { SafeTxServiceAdapter, SafeTxServiceChainError } from '@cclaw/adapters-safe-tx-service';
import { SquadsRpcAdapter, SquadsAddressMissingError, SquadsRpcError } from '@cclaw/adapters-squads-rpc';
import { NotificationsService } from '@cclaw/notifications';
import { SystemService } from '@cclaw/system';
import { getChain, isEvm, isSolana, CHAINS } from '@cclaw/chain';
import { GOVERNANCE_DRIFT_QUEUE } from './queue-names.js';
import {
  readExpectedSafeConfig,
  evaluateSafeDrift,
  readExpectedSquadsConfig,
  evaluateSquadsDrift,
} from './drift-evaluator.js';

/** BullMQ job payload — empty (all config resolved via ConfigService). */
export type GovernanceDriftJobData = Record<string, never>;

/** Structured return value surfaced in BullMQ job result for observability. */
export interface GovernanceDriftResult {
  chainsChecked: number;
  driftAlerts: number;
  skipped: boolean;
}

/**
 * BullMQ processor for governance-drift jobs.
 *
 * Job topology (P3g2 plan, Queue topology):
 *   Queue: `governance-drift` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight cycle at a time (legacy parity).
 *   Retry: 2 attempts, 60 s fixed backoff.
 */
@Processor(GOVERNANCE_DRIFT_QUEUE, { concurrency: 1 })
export class GovernanceDriftProcessor extends WorkerHost {
  private readonly logger = new Logger(GovernanceDriftProcessor.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly safeTxService: SafeTxServiceAdapter,
    private readonly squadsRpc: SquadsRpcAdapter,
    private readonly notificationsService: NotificationsService,
    private readonly systemService: SystemService,
  ) {
    super();
  }

  async process(job: Job<GovernanceDriftJobData>): Promise<GovernanceDriftResult> {
    this.logger.log(`governance-drift: starting job ${job.id}`);

    // Skip in paper mode — governance drift is real-mode only.
    // ADR-0026: per-field get; PAPER_MODE is a boolean post-transform.
    const paperMode = this.configService.get<boolean>('PAPER_MODE');
    if (paperMode) {
      this.logger.log('governance-drift: PAPER_MODE=true — skipping cycle');
      return { chainsChecked: 0, driftAlerts: 0, skipped: true };
    }

    // Resolve active chains — ADR-0026 per-field get.
    const activeChainsCsv = this.configService.get<string>('ACTIVE_CHAINS') ?? '';
    const activeChains = activeChainsCsv
      .split(',')
      .map((c) => c.trim())
      .filter((c) => c.length > 0 && CHAINS[c] !== undefined);

    let chainsChecked = 0;
    let totalAlerts = 0;

    for (const chainName of activeChains) {
      const chain = getChain(chainName);

      try {
        if (isEvm(chain)) {
          // Resolve expected config from ConfigService — ADR-0026 exception:
          // runtime-keyed get for EXPECTED_SAFE_* fields. Keys are a known
          // static set (BASE, ETHEREUM) — not dynamic user input.
          const upper = chainName.toUpperCase();
          const envSubset: Record<string, string | undefined> = {
            [`EXPECTED_SAFE_OWNERS_${upper}`]: this.configService.get<string>(`EXPECTED_SAFE_OWNERS_${upper}`),
            [`EXPECTED_SAFE_THRESHOLD_${upper}`]: this.configService.get<string>(`EXPECTED_SAFE_THRESHOLD_${upper}`),
            [`EXPECTED_SAFE_MODULES_${upper}`]: this.configService.get<string>(`EXPECTED_SAFE_MODULES_${upper}`),
          };
          const expected = readExpectedSafeConfig(chainName, envSubset);

          if (!expected.hasExpectations) {
            this.logger.debug(`governance-drift: no expected config for ${chainName} — skipping`);
            continue;
          }

          // Resolve Safe address for this chain.
          // ADR-0026: per-field get using chain.safe.addressEnv as the key name.
          const safeAddress = this.configService.get<string>(chain.safe.addressEnv);
          if (!safeAddress) {
            this.logger.debug(`governance-drift: no Safe address for ${chainName} — skipping`);
            continue;
          }

          // Fetch on-chain state with a 30 s wall-clock cap.
          const signal = AbortSignal.timeout(30_000);
          const info = await this.safeTxService.getSafeInfo(chainName, safeAddress, signal);

          const result = evaluateSafeDrift({
            observedOwners: info.owners,
            observedThreshold: info.threshold,
            observedModules: info.modules,
            expected,
          });

          chainsChecked++;
          if (result.alerts.length > 0) {
            totalAlerts += result.alerts.length;
            const summary = result.alerts.map((a) => `[${a.type}] ${a.detail}`).join('; ');
            this.logger.warn(`governance-drift: DRIFT on ${chainName}: ${summary}`);
            await this.notificationsService.sendCriticalAlert({
              type: 'rug_warning',
              agent: 'governance',
              message: `GOVERNANCE DRIFT on ${chainName}: ${summary}`,
            });
          } else {
            this.logger.debug(`governance-drift: ${chainName} — no drift detected`);
          }
        } else if (isSolana(chain)) {
          // Squads governance drift — SDK port complete.
          // Read expected members / threshold from ConfigService (ADR-0026).
          const squadsEnvSubset: Record<string, string | undefined> = {
            EXPECTED_SQUADS_MEMBERS: this.configService.get<string>('EXPECTED_SQUADS_MEMBERS'),
            EXPECTED_SQUADS_THRESHOLD: this.configService.get<string>('EXPECTED_SQUADS_THRESHOLD'),
          };
          const expectedSquads = readExpectedSquadsConfig(squadsEnvSubset);

          if (!expectedSquads.hasExpectations) {
            this.logger.debug('governance-drift: no expected Squads config — skipping Solana drift check');
            continue;
          }

          // Fetch on-chain Squads multisig state with a 30 s cap.
          const signal = AbortSignal.timeout(30_000);
          const squadsInfo = await this.squadsRpc.getMultisigInfo(signal);

          const squadsResult = evaluateSquadsDrift({
            observedMembers: squadsInfo.members,
            observedThreshold: squadsInfo.threshold,
            expected: expectedSquads,
          });

          chainsChecked++;
          if (squadsResult.alerts.length > 0) {
            totalAlerts += squadsResult.alerts.length;
            const summary = squadsResult.alerts.map((a) => `[${a.type}] ${a.detail}`).join('; ');
            this.logger.warn(`governance-drift: DRIFT on ${chainName}: ${summary}`);
            await this.notificationsService.sendCriticalAlert({
              type: 'rug_warning',
              agent: 'governance',
              message: `GOVERNANCE DRIFT on ${chainName}: ${summary}`,
            });
          } else {
            this.logger.debug(`governance-drift: ${chainName} — no drift detected`);
          }
        } else {
          this.logger.debug(`governance-drift: unsupported chain ${chainName} — skipping`);
        }
      } catch (err) {
        if (err instanceof SafeTxServiceChainError || err instanceof SquadsAddressMissingError) {
          this.logger.debug(`governance-drift: ${chainName} — ${(err as Error).message}`);
        } else if (err instanceof SquadsRpcError) {
          // RPC error (network, Borsh decode, etc.) — log with chain name only;
          // do NOT surface the RPC URL (may contain API key).
          this.logger.warn(`governance-drift: Squads RPC error on ${chainName} — ${(err as Error).message}`);
        } else {
          // Log non-fatal errors and continue to the next chain.
          this.logger.warn(`governance-drift: error on ${chainName} — ${(err as Error).message}`);
        }
      }
    }

    // Always advance the health meta key regardless of drift outcomes.
    const now = new Date().toISOString();
    await this.systemService.setMeta({ key: 'last_governance_drift_at', value: now });

    const result: GovernanceDriftResult = { chainsChecked, driftAlerts: totalAlerts, skipped: false };
    this.logger.log(`governance-drift: done — checked=${chainsChecked} alerts=${totalAlerts}`);
    return result;
  }
}
