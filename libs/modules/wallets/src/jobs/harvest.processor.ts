/**
 * harvest.processor.ts — BullMQ processor for wallet-harvest jobs.
 *
 * Ports the Birdeye top-gainers harvest loop from the legacy
 * `scripts/score-wallets-bg.js` (self-harvest side-effect) into a
 * standalone, idempotent NestJS processor.
 *
 * Per P3g1 plan [OPEN-2]: harvest is its own job; there is no side-effect
 * harvest from score-wallet.js. The adapter layer owns the Birdeye calls.
 *
 * Job topology (ADR-0024 addendum, P3g1):
 *   Queue: `wallet-harvest` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight harvest at a time (legacy parity: one
 *   process per entrypoint.sh loop).
 *   Retry: 2 attempts, 60 s fixed backoff (user override 2026-05-14,
 *   P3g1 plan [OPEN-4]).
 *
 * Wall-clock cap:
 *   `WALLET_HARVEST_TIMEOUT_MS` (default: 300_000 ms / 5 min).
 *   The 5-min default is conservative relative to the hourly cron — a
 *   stuck harvest cycle is aborted before the next tick even begins.
 *   Typed config + explicit default provides an operator-tunable knob.
 *
 * Idempotency guarantee (DoD §E):
 *   Each token is inserted via `proposeWallet` which uses upsert with an
 *   empty update block (INSERT OR IGNORE semantics). Running this job
 *   twice with the same Birdeye response leaves the DB in the same state
 *   as running it once. Only `last_birdeye_harvest_at` advances.
 *
 * Config access (ADR-0026):
 *   Uses per-field `configService.get<T>('FIELD')` — never aggregate get.
 *   Reads: `ACTIVE_CHAINS`, `WALLET_HARVEST_TIMEOUT_MS`.
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no process.env reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { BirdeyeAdapter } from '@cclaw/adapters-birdeye';
import { WalletsRepository } from '../wallets.repository.js';
import { SystemService } from '@cclaw/system';
import { WALLET_HARVEST_QUEUE } from './queue-names.js';

/**
 * BullMQ job payload for wallet-harvest jobs.
 *
 * Currently empty — all configuration is resolved inside the processor
 * via ConfigService (ACTIVE_CHAINS, WALLET_HARVEST_TIMEOUT_MS). Using
 * `Record<string, never>` instead of an empty interface satisfies the
 * no-empty-object-type lint rule while preserving the explicit payload type.
 */
export type HarvestJobData = Record<string, never>;

/**
 * Structured return value surfaced in BullMQ job result for observability.
 *
 * PR-A nit fix #2 (2026-05-14): renamed `harvested` → `attempted` to clarify
 * that this count represents wallets passed to `proposeWallet` (attempted
 * inserts), NOT confirmed new rows. `proposeWallet` uses INSERT OR IGNORE
 * semantics (upsert with empty update block) — if the address/chain pair
 * already exists, the row is silently left unchanged. The actual number of
 * newly inserted rows cannot be distinguished cheaply from Prisma's upsert
 * response without adding a raw SELECT COUNT query.
 *
 * Downstream callers (scheduler, BullMQ result log): update references from
 * `result.harvested` to `result.attempted`.
 */
export interface HarvestJobResult {
  /** Total number of wallet addresses passed to proposeWallet this cycle. */
  attempted: number;
  /** Breakdown by chain key → count. */
  byChain: Record<string, number>;
}

/**
 * Processor for the `wallet-harvest` BullMQ queue.
 *
 * Steps executed inside `process()`:
 *   1. Build AbortSignal deadline from WALLET_HARVEST_TIMEOUT_MS config.
 *   2. Resolve ACTIVE_CHAINS from config.
 *   3. Fetch top gainers via BirdeyeAdapter.getTopGainersPerChain().
 *   4. Propose each token address as a tracked wallet (INSERT OR IGNORE).
 *   5. Write `last_birdeye_harvest_at` health key via SystemService.setMeta().
 *   6. Return HarvestJobResult for BullMQ result inspection.
 */
@Processor(WALLET_HARVEST_QUEUE, { concurrency: 1 })
export class HarvestProcessor extends WorkerHost {
  private readonly logger = new Logger(HarvestProcessor.name);

  constructor(
    private readonly birdeye: BirdeyeAdapter,
    private readonly walletsRepo: WalletsRepository,
    private readonly systemService: SystemService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<HarvestJobData>): Promise<HarvestJobResult> {
    const startMs = Date.now();
    this.logger.log(`wallet-harvest job started | jobId=${job.id ?? 'n/a'}`);

    // -----------------------------------------------------------------------
    // Step 1: wall-clock cap
    //
    // Default: 300_000 ms (5 min). Operator-tunable via WALLET_HARVEST_TIMEOUT_MS.
    // The hourly cron cadence gives ample headroom even at the default cap.
    // -----------------------------------------------------------------------
    const timeoutMs = this.configService.get<number>('WALLET_HARVEST_TIMEOUT_MS') ?? 300_000;
    const signal = AbortSignal.timeout(timeoutMs);

    // -----------------------------------------------------------------------
    // Step 2: resolve active chains
    //
    // ACTIVE_CHAINS is validated at boot as a comma-separated string.
    // Split + trim here to produce the string[] expected by BirdeyeAdapter.
    // -----------------------------------------------------------------------
    const activeChainsRaw = this.configService.get<string>('ACTIVE_CHAINS') ?? '';
    const chains = activeChainsRaw
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean);

    if (chains.length === 0) {
      this.logger.warn('wallet-harvest: ACTIVE_CHAINS is empty — skipping harvest');
      await this.systemService.setMeta({
        key: 'last_birdeye_harvest_at',
        value: new Date().toISOString(),
      });
      return { attempted: 0, byChain: {} };
    }

    // -----------------------------------------------------------------------
    // Step 3: fetch top gainers
    // -----------------------------------------------------------------------
    this.logger.debug(`wallet-harvest: fetching top gainers for chains=${chains.join(',')}`);
    const tokens = await this.birdeye.getTopGainersPerChain(chains, { signal });

    this.logger.log(`wallet-harvest: birdeye returned ${tokens.length} tokens | elapsed=${Date.now() - startMs}ms`);

    // -----------------------------------------------------------------------
    // Step 4: propose wallets (INSERT OR IGNORE via proposeWallet)
    //
    // Each token's contract address is proposed as a tracked wallet with
    // source='birdeye-harvest'. proposeWallet uses upsert with an empty
    // update block — if the address/chain pair already exists the row is
    // untouched (idempotency guarantee, DoD §E).
    //
    // We do NOT wrap in a Prisma $transaction here because proposeWallet
    // is already individual-row safe and holding a single transaction open
    // for potentially 20+ inserts can cause lock contention in SQLite WAL.
    // -----------------------------------------------------------------------
    const byChain: Record<string, number> = {};
    let attempted = 0;

    for (const token of tokens) {
      try {
        await this.walletsRepo.proposeWallet({
          address: token.address,
          chain: token.chain,
          label: token.symbol || undefined,
          source: 'birdeye-harvest',
        });

        byChain[token.chain] = (byChain[token.chain] ?? 0) + 1;
        attempted++;
      } catch (err) {
        // Log and continue — a single insert failure should not abort the cycle.
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`wallet-harvest: failed to propose ${token.address}/${token.chain}: ${msg}`);
      }
    }

    // -----------------------------------------------------------------------
    // Step 5: write health meta key
    // -----------------------------------------------------------------------
    await this.systemService.setMeta({
      key: 'last_birdeye_harvest_at',
      value: new Date().toISOString(),
    });

    const elapsedMs = Date.now() - startMs;
    this.logger.log(
      `wallet-harvest done | attempted=${attempted} chains=${Object.keys(byChain).join(',')} elapsedMs=${elapsedMs}`,
    );

    return { attempted, byChain };
  }
}
