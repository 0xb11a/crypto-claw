/**
 * score-wallets.processor.ts — BullMQ processor for wallet-scoring jobs.
 *
 * Ports the `scripts/score-wallets-bg.js` background loop into a standalone,
 * idempotent NestJS processor. The legacy script ran via `execFileSync` to
 * invoke `score-wallet.js` per wallet (30 s process timeout). This processor
 * replaces that with an in-process `AbortController` + `Promise.allSettled`
 * for the three parallel API calls (P3g1 plan §5).
 *
 * Per-cycle algorithm (legacy parity — DoD §I):
 *   0. Self-seed gate: if `now - last_birdeye_harvest_at >= 60 min`, enqueue
 *      a `wallet-harvest` job (do NOT inline-call the harvest logic). Gate
 *      uses the same `last_birdeye_harvest_at` key as the legacy script.
 *   1. `walletsRepo.findUnscored(BATCH_SIZE)` — up to 10 wallets with
 *      status='proposed' or status='failed' AND retry_count < 3.
 *   2. For each wallet (sequentially):
 *      a. Single AbortController with WALLET_SCORING_PER_WALLET_TIMEOUT_MS cap.
 *      b. Promise.allSettled([birdeye.getTraderRank, birdeye.getTokenTopTraders,
 *         zerion.getPnl]).
 *      c. Pass results to ScoreWalletService.scoreFromBirdeyeAndZerion().
 *      d. On success: walletsRepo.updateScore().
 *      e. On all-failed or timeout: walletsRepo.updateScore() with status='failed'
 *         and score_error populated.
 *      f. WALLET_SCORING_INTER_WALLET_DELAY_MS delay between wallets (3 s default).
 *   3. Write `last_score_wallets_bg_at` health meta key.
 *
 * [OPEN-2] Side-effect harvest dropped: the legacy `score-wallet.js` harvested
 * Birdeye leaderboard wallets as a side effect per wallet. We drop that side
 * effect — harvest is owned exclusively by the `wallet-harvest` queue.
 *
 * Job topology (ADR-0024 addendum, P3g1):
 *   Queue: `wallet-scoring` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight scoring cycle at a time (legacy parity).
 *   Retry: 2 attempts, 60 s fixed backoff (P3g1 plan [OPEN-4]).
 *
 * Idempotency guarantee (DoD §E):
 *   updateScore is idempotent — calling it twice for the same wallet updates
 *   the same row without side effects. Only `last_score_wallets_bg_at` advances.
 *
 * Config access (ADR-0026):
 *   Uses per-field `configService.get<T>('FIELD')`.
 *   Reads: WALLET_SCORING_PER_WALLET_TIMEOUT_MS, WALLET_SCORING_INTER_WALLET_DELAY_MS.
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no process.env reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { BirdeyeAdapter, BirdeyeApiKeyMissingError } from '@cclaw/adapters-birdeye';
import { ZerionAdapter, ZerionApiKeyMissingError } from '@cclaw/adapters-zerion';
import { WalletsRepository } from '../wallets.repository.js';
import { SystemService } from '@cclaw/system';
import { ScoreWalletService } from './score-wallet.service.js';
import { WALLET_HARVEST_QUEUE, WALLET_SCORING_QUEUE } from './queue-names.js';

/** Default batch size per cycle — mirrors legacy BATCH_SIZE = 10 in score-wallets-bg.js. */
const BATCH_SIZE = 10;

/** 60-minute harvest interval in ms — mirrors legacy HARVEST_INTERVAL_MS. */
const HARVEST_INTERVAL_MS = 60 * 60 * 1000;

/**
 * BullMQ job payload for wallet-scoring jobs.
 *
 * Currently empty — all configuration is resolved inside the processor
 * via ConfigService. Using `Record<string, never>` satisfies the
 * no-empty-object-type lint rule.
 */
export type ScoreWalletsJobData = Record<string, never>;

/**
 * Structured return value surfaced in BullMQ job result for observability.
 *
 * Naming chosen for clarity from day 1 (locked decision, PR-B):
 *   wallets_scored — wallets that received a classification this cycle.
 *   wallets_failed — wallets that failed all API calls and were marked 'failed'.
 *   classification_counts — breakdown by classification tier.
 */
export interface ScoreWalletsJobResult {
  /** Number of wallets successfully scored in this cycle. */
  wallets_scored: number;
  /** Number of wallets that failed scoring (API errors, timeout). */
  wallets_failed: number;
  /** Breakdown of successful classifications. */
  classification_counts: {
    smart_money: number;
    whale: number;
    lowtier: number;
  };
  /** Whether a harvest job was enqueued during this cycle. */
  harvest_enqueued: boolean;
}

/**
 * Processor for the `wallet-scoring` BullMQ queue.
 *
 * Algorithm: see module JSDoc above.
 */
@Processor(WALLET_SCORING_QUEUE, { concurrency: 1 })
export class ScoreWalletsProcessor extends WorkerHost {
  private readonly logger = new Logger(ScoreWalletsProcessor.name);

  constructor(
    @InjectQueue(WALLET_HARVEST_QUEUE) private readonly harvestQueue: Queue,
    private readonly birdeye: BirdeyeAdapter,
    private readonly zerion: ZerionAdapter,
    private readonly walletsRepo: WalletsRepository,
    private readonly systemService: SystemService,
    private readonly configService: ConfigService,
    private readonly scoreWalletService: ScoreWalletService,
  ) {
    super();
  }

  async process(job: Job<ScoreWalletsJobData>): Promise<ScoreWalletsJobResult> {
    const startMs = Date.now();
    this.logger.log(`wallet-scoring job started | jobId=${job.id ?? 'n/a'}`);

    // -----------------------------------------------------------------------
    // Per-wallet timeout (ADR-0026: per-field config access)
    // Default: 30_000 ms (30 s) — matches legacy execFileSync 30s timeout.
    // -----------------------------------------------------------------------
    const perWalletTimeoutMs = this.configService.get<number>('WALLET_SCORING_PER_WALLET_TIMEOUT_MS') ?? 30_000;

    // -----------------------------------------------------------------------
    // Inter-wallet delay (ADR-0026)
    // Default: 3_000 ms (3 s) — mirrors legacy DELAY_MS = 3000 in score-wallets-bg.js.
    // -----------------------------------------------------------------------
    const interWalletDelayMs = this.configService.get<number>('WALLET_SCORING_INTER_WALLET_DELAY_MS') ?? 3_000;

    const result: ScoreWalletsJobResult = {
      wallets_scored: 0,
      wallets_failed: 0,
      classification_counts: { smart_money: 0, whale: 0, lowtier: 0 },
      harvest_enqueued: false,
    };

    // -----------------------------------------------------------------------
    // Step 0: Self-seed gate
    // If last_birdeye_harvest_at is >= 60 min stale, enqueue a harvest job.
    // Does NOT inline-call the harvest logic — the harvest queue owns it.
    // mirrors score-wallets-bg.js:57-81
    // -----------------------------------------------------------------------
    try {
      const lastHarvestMeta = await this.systemService.getMeta('last_birdeye_harvest_at');
      const lastHarvestMs = lastHarvestMeta?.value ? new Date(lastHarvestMeta.value).getTime() : 0;
      const elapsed = Date.now() - lastHarvestMs;

      if (elapsed >= HARVEST_INTERVAL_MS) {
        this.logger.log(
          `wallet-scoring: last_birdeye_harvest_at is ${Math.round(elapsed / 60000)}m stale — enqueueing harvest`,
        );
        await this.harvestQueue.add('harvest', {});
        result.harvest_enqueued = true;
      } else {
        const minLeft = Math.round((HARVEST_INTERVAL_MS - elapsed) / 60000);
        this.logger.debug(`wallet-scoring: harvest gate OK (next harvest in ~${minLeft}m)`);
      }
    } catch (err) {
      // Gate failure is non-fatal — log and continue with scoring
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`wallet-scoring: harvest gate check failed (non-fatal): ${msg}`);
    }

    // -----------------------------------------------------------------------
    // Step 1: Find unscored wallets
    // mirrors score-wallets-bg.js:84-109
    // -----------------------------------------------------------------------
    const wallets = await this.walletsRepo.findUnscored(BATCH_SIZE);

    if (wallets.length === 0) {
      this.logger.log(`wallet-scoring: no unscored wallets in queue | elapsed=${Date.now() - startMs}ms`);
      await this.writeHealthKey();
      return result;
    }

    this.logger.log(`wallet-scoring: processing ${wallets.length} wallets`);

    // -----------------------------------------------------------------------
    // Step 2: Process each wallet sequentially
    // mirrors score-wallets-bg.js:115-208
    // -----------------------------------------------------------------------
    for (let i = 0; i < wallets.length; i++) {
      const wallet = wallets[i];

      // Per-wallet AbortController — single deadline covers all three API calls.
      const controller = new AbortController();
      const timeoutHandle = setTimeout(() => controller.abort(), perWalletTimeoutMs);

      try {
        // -------------------------------------------------------------------
        // Step 2b: Parallel API calls
        // -------------------------------------------------------------------
        const [traderRankOutcome, tokenTopTraderOutcome, zerionPnlOutcome] = await Promise.allSettled([
          this.birdeye
            .getTraderRank(wallet.address, wallet.chain, { signal: controller.signal })
            .catch((err: unknown) => {
              if (err instanceof BirdeyeApiKeyMissingError) return null;
              throw err;
            }),
          this.birdeye
            .getTokenTopTraders(wallet.address, wallet.source_token ?? '', wallet.chain, { signal: controller.signal })
            .catch((err: unknown) => {
              if (err instanceof BirdeyeApiKeyMissingError) return null;
              throw err;
            }),
          this.zerion
            .getPnl(wallet.address, { chain: wallet.chain, signal: controller.signal })
            .catch((err: unknown) => {
              if (err instanceof ZerionApiKeyMissingError) return null;
              throw err;
            }),
        ]);

        clearTimeout(timeoutHandle);

        const traderRank = traderRankOutcome.status === 'fulfilled' ? traderRankOutcome.value : null;
        const tokenTopTrader = tokenTopTraderOutcome.status === 'fulfilled' ? tokenTopTraderOutcome.value : null;
        const zerionPnl = zerionPnlOutcome.status === 'fulfilled' ? zerionPnlOutcome.value : null;

        // All three failed → mark failed
        const allFailed =
          traderRankOutcome.status === 'rejected' &&
          tokenTopTraderOutcome.status === 'rejected' &&
          zerionPnlOutcome.status === 'rejected';

        if (allFailed) {
          const primaryError =
            traderRankOutcome.status === 'rejected'
              ? (traderRankOutcome.reason as Error).message
              : 'All scoring APIs failed';

          await this.walletsRepo.updateScore(wallet.address, wallet.chain, {
            status: 'failed',
            score_error: primaryError.slice(0, 200),
          });

          this.logger.warn(`wallet-scoring: all APIs failed for ${wallet.address}/${wallet.chain}: ${primaryError}`);
          result.wallets_failed++;
          continue;
        }

        // -------------------------------------------------------------------
        // Step 2c: Compute score
        // -------------------------------------------------------------------
        const scored = this.scoreWalletService.scoreFromBirdeyeAndZerion(traderRank, tokenTopTrader, zerionPnl);

        // No data at all (all returned null — API keys missing or no data)
        if (scored.overall === 0 && traderRank === null && tokenTopTrader === null && zerionPnl === null) {
          await this.walletsRepo.updateScore(wallet.address, wallet.chain, {
            status: 'failed',
            score_error: 'No data from scoring APIs (keys may not be configured)',
          });
          this.logger.warn(`wallet-scoring: no API data for ${wallet.address}/${wallet.chain}`);
          result.wallets_failed++;
          continue;
        }

        // -------------------------------------------------------------------
        // Step 2d: Persist score
        // -------------------------------------------------------------------
        await this.walletsRepo.updateScore(wallet.address, wallet.chain, {
          score: scored.overall,
          type: scored.classification,
          score_breakdown: scored.breakdown,
          status: 'scored',
        });

        this.logger.log(
          `wallet-scoring: scored ${wallet.address}/${wallet.chain}: ${scored.overall} → ${scored.classification}`,
        );

        result.wallets_scored++;
        result.classification_counts[scored.classification]++;
      } catch (err) {
        clearTimeout(timeoutHandle);

        const isAborted = controller.signal.aborted;
        const msg = isAborted
          ? `Timed out after ${perWalletTimeoutMs}ms`
          : err instanceof Error
            ? err.message
            : String(err);

        await this.walletsRepo.updateScore(wallet.address, wallet.chain, {
          status: 'failed',
          score_error: msg.slice(0, 200),
        });

        this.logger.warn(`wallet-scoring: error scoring ${wallet.address}/${wallet.chain}: ${msg}`);
        result.wallets_failed++;
      }

      // -------------------------------------------------------------------
      // Step 2f: Inter-wallet delay (skip after last wallet)
      // mirrors score-wallets-bg.js:204-207
      // -------------------------------------------------------------------
      if (i < wallets.length - 1) {
        await sleep(interWalletDelayMs);
      }
    }

    // -----------------------------------------------------------------------
    // Step 3: Write health meta key
    // mirrors score-wallets-bg.js:210
    // -----------------------------------------------------------------------
    await this.writeHealthKey();

    const elapsedMs = Date.now() - startMs;
    this.logger.log(
      `wallet-scoring done | scored=${result.wallets_scored} failed=${result.wallets_failed}` +
        ` sm=${result.classification_counts.smart_money} whale=${result.classification_counts.whale}` +
        ` lowtier=${result.classification_counts.lowtier} elapsed=${elapsedMs}ms`,
    );

    return result;
  }

  /** Write the `last_score_wallets_bg_at` health meta key. */
  private async writeHealthKey(): Promise<void> {
    await this.systemService.setMeta({
      key: 'last_score_wallets_bg_at',
      value: new Date().toISOString(),
    });
  }
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
