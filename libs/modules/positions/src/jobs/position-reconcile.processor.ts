/**
 * position-reconcile.processor.ts — BullMQ processor for position-reconcile jobs.
 *
 * Ports the `scripts/reconcile-positions.js` reconcile loop into a standalone,
 * idempotent NestJS processor.
 *
 * Per-cycle algorithm (legacy parity — DoD §I):
 *   1. Skip if `PAPER_MODE === true` (parity with `scripts/reconcile-positions.js:37`).
 *   2. Load all open/partial_exit real-mode positions via `PositionsService.findOpenAndPartialExit()`.
 *   3. For each position:
 *      a. Resolve vault address from ConfigService (chain.safe.addressEnv for EVM,
 *         chain.squads.vaultEnv for Solana — mirrors `getVaultAddress` in legacy).
 *      b. Fetch decimals via `OnchainBalanceAdapter.getTokenDecimals()`.
 *      c. Fetch on-chain balance via `OnchainBalanceAdapter.getTokenBalance()`.
 *      d. `evaluatePositionDrift({dbQty, onchainQty})` — pure function.
 *      e. If drift AND `shouldAppendDriftMarker()` returns true:
 *         `positionsService.appendNote(id, marker)`.
 *      f. Wait 200 ms between positions (legacy rate-limit parity,
 *         `reconcile-positions.js:189`).
 *   4. If `driftCount > 0`: `notificationsService.sendRugWarning('system', '...')`.
 *   5. Always write `systemService.setMeta('last_position_reconcile_at', now)`.
 *
 * Idempotency (DoD §E):
 *   - Running twice with same on-chain state leaves DB identical:
 *     `shouldAppendDriftMarker` deduplicates within the same UTC hour.
 *   - Only `last_position_reconcile_at` advances on each run.
 *
 * Config access (ADR-0026 — per-field):
 *   - `PAPER_MODE`
 *   - `ACTIVE_CHAINS`
 *   - `SAFE_ADDRESS_<CHAIN>` (resolved via chain.safe.addressEnv)
 *   - `SQUADS_VAULT_ADDRESS` / `SQUADS_MULTISIG_ADDRESS` (Solana vault)
 *   - `RPC_VALIDATION_MODE`
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no `process.env` reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { OnchainBalanceAdapter, evaluatePositionDrift } from '@cclaw/adapters-onchain-balance';
import { NotificationsService } from '@cclaw/notifications';
import { SystemService } from '@cclaw/system';
import { getChain, isEvm, isSolana, type EvmChain, type SolanaChain } from '@cclaw/chain';
import { PositionsService } from '../positions.service.js';
import { POSITION_RECONCILE_QUEUE } from './queue-names.js';
import { shouldAppendDriftMarker } from '../notes-utils.js';

/** BullMQ job payload — empty (all config resolved via ConfigService). */
export type PositionReconcileJobData = Record<string, never>;

/** Structured return value for observability. */
export interface PositionReconcileResult {
  totalPositions: number;
  driftCount: number;
  errorCount: number;
  skipped: boolean;
}

/**
 * BullMQ processor for position-reconcile jobs.
 *
 * Job topology (P3g2 plan, Queue topology):
 *   Queue: `position-reconcile` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight cycle at a time (legacy parity).
 *   Retry: 2 attempts, fixed 60 s backoff (mirrors P3g1 policy).
 */
@Processor(POSITION_RECONCILE_QUEUE, { concurrency: 1 })
export class PositionReconcileProcessor extends WorkerHost {
  private readonly logger = new Logger(PositionReconcileProcessor.name);

  constructor(
    private readonly positionsService: PositionsService,
    private readonly onchainBalance: OnchainBalanceAdapter,
    private readonly notifications: NotificationsService,
    private readonly systemService: SystemService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  /** PAPER_MODE check — ADR-0026 per-field. */
  private get isPaperMode(): boolean {
    const raw = this.configService.get<string>('PAPER_MODE');
    return raw === 'true' || raw === '1';
  }

  /**
   * Resolve the vault address for a chain.
   *
   * Port of `scripts/reconcile-positions.js:getVaultAddress` (DoD §I).
   * ADR-0026: per-field config reads.
   */
  private getVaultAddress(chainName: string): string | null {
    const chain = getChain(chainName);
    if (isEvm(chain)) {
      return this.configService.get<string>((chain as EvmChain).safe.addressEnv) ?? null;
    }
    if (isSolana(chain)) {
      const solChain = chain as SolanaChain;
      const direct = this.configService.get<string>(solChain.squads.vaultEnv);
      if (direct) return direct;
      // Fall back: prefer direct vault env; multisig PDA derivation deferred (requires SDK).
      // Log a warning — operator should set SQUADS_VAULT_ADDRESS for reconcile to work on Solana.
      this.logger.warn(
        `position-reconcile: ${solChain.squads.vaultEnv} not set and PDA derivation requires SDK — ` +
          `set ${solChain.squads.vaultEnv} for Solana reconcile support`,
      );
      return null;
    }
    return null;
  }

  /**
   * Process a position-reconcile job.
   *
   * One job = one full reconcile cycle across all open/partial_exit positions.
   */
  async process(job: Job<PositionReconcileJobData>): Promise<PositionReconcileResult> {
    this.logger.log(`position-reconcile: starting job ${job.id}`);

    // 1. Paper-mode skip.
    if (this.isPaperMode) {
      this.logger.debug('position-reconcile: PAPER_MODE=true — skipping');
      await this.systemService.setMeta({ key: 'last_position_reconcile_at', value: new Date().toISOString() });
      return { totalPositions: 0, driftCount: 0, errorCount: 0, skipped: true };
    }

    // 2. Load all open/partial_exit positions.
    const positions = await this.positionsService.findOpenAndPartialExit();
    this.logger.log(`position-reconcile: found ${positions.length} open/partial_exit positions`);

    let driftCount = 0;
    let errorCount = 0;
    const driftSummary: string[] = [];

    // 3. Per-position reconcile.
    for (const pos of positions) {
      try {
        // Resolve vault address.
        const owner = this.getVaultAddress(pos.chain);
        if (!owner) {
          this.logger.warn(
            `position-reconcile: vault_address_not_resolved for chain ${pos.chain} — skipping ${pos.symbol} (${pos.id})`,
          );
          errorCount++;
          continue;
        }

        // Fetch decimals.
        let decimals: number;
        try {
          decimals = await this.onchainBalance.getTokenDecimals(pos.chain, pos.address);
        } catch (err) {
          this.logger.warn(
            `position-reconcile: decimals_fetch_failed for ${pos.symbol} (${pos.id}): ${(err as Error).message.slice(0, 100)}`,
          );
          errorCount++;
          // 200 ms delay even on error (legacy parity).
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

        // Fetch on-chain balance.
        let onchainQty: number;
        try {
          onchainQty = await this.onchainBalance.getTokenBalance(pos.chain, pos.address, owner, decimals);
        } catch (err) {
          this.logger.warn(
            `position-reconcile: balance_fetch_failed for ${pos.symbol} (${pos.id}): ${(err as Error).message.slice(0, 100)}`,
          );
          errorCount++;
          await new Promise((r) => setTimeout(r, 200));
          continue;
        }

        // Evaluate drift.
        const drift = evaluatePositionDrift({ dbQty: pos.quantity, onchainQty });

        if (!drift.valid) {
          driftCount++;
          const ts = new Date().toISOString().slice(0, 19);
          const marker =
            `[${ts}] recon_drift_${drift.driftPct.toFixed(2)}pct ` +
            `direction=${drift.direction} db=${pos.quantity} onchain=${onchainQty}`;

          // Idempotency guard: only append if not already in notes for this hour.
          if (shouldAppendDriftMarker(pos.notes ?? '', drift.driftPct)) {
            await this.positionsService.appendNote(pos.id, marker);
            this.logger.warn(
              `position-reconcile: position_drift ${pos.symbol} (${pos.id}) on ${pos.chain}: ` +
                `db=${pos.quantity} onchain=${onchainQty} drift=${drift.driftPct.toFixed(2)}% direction=${drift.direction}`,
            );
          } else {
            this.logger.debug(
              `position-reconcile: drift marker already present for ${pos.symbol} (${pos.id}) this hour — skipping duplicate append`,
            );
          }

          driftSummary.push(`${pos.symbol}(${pos.chain}):${drift.driftPct.toFixed(2)}%`);
        }
      } catch (err) {
        this.logger.error(
          `position-reconcile: unexpected error for ${pos.symbol} (${pos.id}): ${(err as Error).message}`,
        );
        errorCount++;
      }

      // 200 ms delay between positions (legacy rate-limit parity).
      await new Promise((r) => setTimeout(r, 200));
    }

    // 4. Alert if drift detected.
    if (driftCount > 0) {
      const summary = driftSummary.join(', ');
      await this.notifications.sendRugWarning(
        'system',
        `POSITION DRIFT detected on ${driftCount} position(s): ${summary}. ` +
          `Inspect and decide whether to sell or adjust DB records.`,
      );
    }

    // 5. Write health meta.
    const now = new Date().toISOString();
    await this.systemService.setMeta({ key: 'last_position_reconcile_at', value: now });

    this.logger.log(`position-reconcile: done — total=${positions.length} drifted=${driftCount} errors=${errorCount}`);

    return { totalPositions: positions.length, driftCount, errorCount, skipped: false };
  }
}
