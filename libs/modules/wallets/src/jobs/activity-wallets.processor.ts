/**
 * activity-wallets.processor.ts — BullMQ processor for wallet-activity jobs.
 *
 * Ports the `scripts/activity-wallets-bg.js` background loop into a standalone,
 * idempotent NestJS processor. Polls a rotating slice of smart_money wallets for
 * recent on-chain swaps and writes one signal row per detected swap into
 * `smart_money_signals`.
 *
 * Per-cycle algorithm (legacy parity — DoD §I):
 *   0. `signalsRepo.pruneOlderThan(24)` — remove signals older than 24 h.
 *   1. `walletsRepo.findActivityCandidates(BATCH_SIZE)` — up to 10 smart_money
 *      wallets ordered by `last_checked_at ASC NULLS FIRST` (rotation).
 *   2. Group wallets by chain.
 *   3. `Promise.allSettled(chains.map(processChain))` — chains run in parallel.
 *   4. Per chain (sequential):
 *      a. Per wallet: fetch tokentx (EVM) or parsed transactions (Solana) with
 *         `AbortSignal.timeout(WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS)` (default 10 s).
 *      b. Per-chain fail-fast: `WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT` consecutive
 *         timeouts → break chain loop (default 5).
 *      c. After every wallet (success or failure), `walletsRepo.updateLastChecked()`.
 *         Rotation MUST advance even on failure so a dead wallet doesn't block.
 *      d. For each extracted swap, `signalsRepo.insertSignal()` (UPSERT / INSERT OR IGNORE).
 *      e. `WALLET_ACTIVITY_INTER_WALLET_DELAY_MS` delay between wallets (default 250 ms).
 *   5. `system.setMeta('last_activity_wallets_bg_at', now)`.
 *
 * Failure semantics (locked decision, P3g1):
 *   `markFailed` is NOT called here. Rotation advances, but wallets are NOT marked
 *   `status='failed'` from the activity pipeline. Only the scoring pipeline marks failure.
 *   Per-chain fail-fast resets on each job invocation (per-job counter scope).
 *
 * Job topology (ADR-0024 addendum, P3g1):
 *   Queue: `wallet-activity` — global singleton, not per-Safe.
 *   Concurrency: 1 — one in-flight activity cycle at a time (legacy parity).
 *   Retry: 2 attempts, 60 s fixed backoff (P3g1 plan [OPEN-4]).
 *
 * Idempotency guarantee (DoD §E):
 *   `insertSignal` uses upsert with empty update block (INSERT OR IGNORE semantics).
 *   Running twice over the same input leaves the DB unchanged after the second run.
 *   Only `last_activity_wallets_bg_at` advances.
 *
 * Config access (ADR-0026):
 *   Uses per-field `configService.get<T>('FIELD')`.
 *   Reads: ACTIVE_CHAINS, WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS,
 *          WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT,
 *          WALLET_ACTIVITY_INTER_WALLET_DELAY_MS.
 *
 * SPEC §4 #4: no signer-key env vars read here.
 * SPEC §4 #6: no process.env reads — all config via ConfigService.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { HeliusAdapter, HeliusApiKeyMissingError } from '@cclaw/adapters-helius';
import {
  EvmExplorerAdapter,
  EvmExplorerApiKeyMissingError,
  EvmExplorerUnsupportedChainError,
} from '@cclaw/adapters-evm-explorer';
import { WalletsRepository } from '../wallets.repository.js';
import { SignalsRepository } from '../signals.repository.js';
import { SystemService } from '@cclaw/system';
import { WALLET_ACTIVITY_QUEUE } from './queue-names.js';
import { extractEvmSwaps, extractSolanaSwaps } from './swap-extraction.js';

// ---------------------------------------------------------------------------
// Chain-specific stablecoin/wrapped-native helpers
// ---------------------------------------------------------------------------

/**
 * Stablecoin sets and wrapped-native addresses, ported from scripts/chains.js.
 *
 * We inline these here rather than importing scripts/chains.js (which uses
 * process.env and is a legacy CommonJS module) to respect SPEC §4 #6 and
 * the adapter boundary. They must be kept in sync with scripts/chains.js.
 *
 * Note: EVM addresses are lowercased here (per legacy parity — `getStablecoins`
 * lowercases EVM addresses, uses exact case for Solana).
 */
const EVM_STABLES: Record<string, string[]> = {
  base: [
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDT
    '0x50c5725949a6f0c72e6c4a641f24049a917db0cb', // DAI
    '0x4621b7a9c75199271f773ebd9a499dbd165c3191', // DOLA
  ],
  ethereum: [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0x6b175474e89094c44da98b954eedeac495271d0f', // DAI
  ],
};

const EVM_WNATIVE: Record<string, string> = {
  base: '0x4200000000000000000000000000000000000006', // WETH
  ethereum: '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
};

const SOLANA_STABLES = new Set([
  'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
  'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
  'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
]);

const SOLANA_WSOL = 'So11111111111111111111111111111111111111112';

/** Get the stablecoin Set for a chain. EVM addresses are pre-lowercased. */
function getStables(chain: string): ReadonlySet<string> {
  if (chain === 'solana') return SOLANA_STABLES;
  return new Set(EVM_STABLES[chain] ?? []);
}

/** Get the wrapped native token address for a chain. */
function getWrappedNative(chain: string): string | undefined {
  if (chain === 'solana') return SOLANA_WSOL;
  return EVM_WNATIVE[chain];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Returns true if `err` is a fetch timeout or abort error.
 *
 * Mirrors `isTimeoutError()` in `scripts/activity-wallets-bg.js:204-206`.
 */
function isTimeoutError(err: unknown): boolean {
  const name = (err as Error | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

// ---------------------------------------------------------------------------
// Job types
// ---------------------------------------------------------------------------

/**
 * BullMQ job payload for wallet-activity jobs.
 *
 * Currently empty — all configuration is resolved inside the processor
 * via ConfigService. Using `Record<string, never>` satisfies the
 * no-empty-object-type lint rule.
 */
export type ActivityWalletsJobData = Record<string, never>;

/**
 * Per-chain result summary returned by the processor.
 */
interface ChainResult {
  checked: number;
  signals: number;
  skipped: number;
  timeouts: number;
  errors: number;
}

/**
 * Structured return value surfaced in BullMQ job result for observability.
 */
export interface ActivityWalletsJobResult {
  /** Total wallets whose `last_checked_at` was updated this cycle. */
  checked: number;
  /** Total new signal rows inserted. */
  signals_written: number;
  /** Total signal rows deleted (older than 24 h). */
  pruned: number;
  /** Per-chain breakdown. */
  chains: Record<string, ChainResult>;
}

// ---------------------------------------------------------------------------
// Processor
// ---------------------------------------------------------------------------

/** Batch size per cycle — mirrors legacy BATCH_SIZE = 10. */
const BATCH_SIZE = 10;

/** Default per-fetch timeout (ms) — mirrors legacy FETCH_TIMEOUT_MS = 10_000. */
const DEFAULT_PER_FETCH_TIMEOUT_MS = 10_000;

/** Default per-chain fail-fast threshold — mirrors legacy FAIL_FAST_CONSECUTIVE = 5. */
const DEFAULT_PER_CHAIN_TIMEOUT_LIMIT = 5;

/** Default inter-wallet delay (ms) — mirrors legacy PER_CHAIN_DELAY_MS = 250. */
const DEFAULT_INTER_WALLET_DELAY_MS = 250;

/** Signal retention window (hours) — mirrors legacy RETENTION_HOURS = 24. */
const RETENTION_HOURS = 24;

/**
 * Processor for the `wallet-activity` BullMQ queue.
 *
 * Algorithm: see module JSDoc above.
 */
@Processor(WALLET_ACTIVITY_QUEUE, { concurrency: 1 })
export class ActivityWalletsProcessor extends WorkerHost {
  private readonly logger = new Logger(ActivityWalletsProcessor.name);

  constructor(
    private readonly helius: HeliusAdapter,
    private readonly evmExplorer: EvmExplorerAdapter,
    private readonly walletsRepo: WalletsRepository,
    private readonly signalsRepo: SignalsRepository,
    private readonly systemService: SystemService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  async process(job: Job<ActivityWalletsJobData>): Promise<ActivityWalletsJobResult> {
    const startMs = Date.now();
    this.logger.log(`wallet-activity job started | jobId=${job.id ?? 'n/a'}`);

    // -----------------------------------------------------------------------
    // Config reads (ADR-0026: per-field access)
    // -----------------------------------------------------------------------
    const perFetchTimeoutMs =
      this.configService.get<number>('WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS') ?? DEFAULT_PER_FETCH_TIMEOUT_MS;

    const perChainTimeoutLimit =
      this.configService.get<number>('WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT') ?? DEFAULT_PER_CHAIN_TIMEOUT_LIMIT;

    const interWalletDelayMs =
      this.configService.get<number>('WALLET_ACTIVITY_INTER_WALLET_DELAY_MS') ?? DEFAULT_INTER_WALLET_DELAY_MS;

    // -----------------------------------------------------------------------
    // Step 0: Prune old signals (24 h retention)
    // mirrors activity-wallets-bg.js:224-226
    // -----------------------------------------------------------------------
    const { deleted: pruned } = await this.signalsRepo.pruneOlderThan(RETENTION_HOURS);
    this.logger.debug(`wallet-activity: pruned ${pruned} signals older than ${RETENTION_HOURS}h`);

    // -----------------------------------------------------------------------
    // Step 1: Pick next BATCH_SIZE smart_money wallets by oldest last_checked_at
    // mirrors activity-wallets-bg.js:228-239
    // -----------------------------------------------------------------------
    const wallets = await this.walletsRepo.findActivityCandidates(BATCH_SIZE);

    if (wallets.length === 0) {
      this.logger.log(
        `wallet-activity: no smart_money wallets to check (pool empty — upstream pipeline may be stalled), pruned=${pruned}`,
      );
      await this.writeHealthKey();
      return { checked: 0, signals_written: 0, pruned, chains: {} };
    }

    this.logger.log(`wallet-activity: processing ${wallets.length} wallets`);

    // -----------------------------------------------------------------------
    // Step 2: Group by chain
    // mirrors activity-wallets-bg.js:274-276
    // -----------------------------------------------------------------------
    const byChain: Record<string, typeof wallets> = {};
    for (const w of wallets) {
      if (!byChain[w.chain]) byChain[w.chain] = [];
      byChain[w.chain].push(w);
    }

    // -----------------------------------------------------------------------
    // Steps 3-6: Process chains in parallel; wallets sequential within chain
    // mirrors activity-wallets-bg.js:283-373 (Promise.all)
    // -----------------------------------------------------------------------
    let totalChecked = 0;
    let totalSignals = 0;
    const chainResults: Record<string, ChainResult> = {};

    // Promise.allSettled mirrors legacy Promise.all — failures in one chain
    // don't abort other chains.
    await Promise.allSettled(
      Object.entries(byChain).map(async ([chain, chainWallets]) => {
        const result = await this.processChain(
          chain,
          chainWallets,
          perFetchTimeoutMs,
          perChainTimeoutLimit,
          interWalletDelayMs,
        );
        chainResults[chain] = result;
        totalChecked += result.checked;
        totalSignals += result.signals;
      }),
    );

    // -----------------------------------------------------------------------
    // Step 7: Write bg health timestamp (observer reads this)
    // mirrors activity-wallets-bg.js:374-375
    // -----------------------------------------------------------------------
    await this.writeHealthKey();

    const elapsedMs = Date.now() - startMs;
    this.logger.log(
      `wallet-activity done | checked=${totalChecked} signals=${totalSignals} pruned=${pruned}` +
        ` chains=${JSON.stringify(chainResults)} elapsed=${elapsedMs}ms`,
    );

    return {
      checked: totalChecked,
      signals_written: totalSignals,
      pruned,
      chains: chainResults,
    };
  }

  /**
   * Process all wallets for one chain sequentially.
   *
   * Implements the per-chain fail-fast counter and the 250 ms inter-wallet delay.
   * Counter resets at the start of each job invocation (per-job scope, per legacy).
   */
  private async processChain(
    chain: string,
    chainWallets: Awaited<ReturnType<WalletsRepository['findActivityCandidates']>>,
    perFetchTimeoutMs: number,
    perChainTimeoutLimit: number,
    interWalletDelayMs: number,
  ): Promise<ChainResult> {
    let consecutiveTimeouts = 0;
    let chainChecked = 0;
    let chainSignals = 0;
    let chainSkipped = 0;
    let chainTimeouts = 0;
    let chainErrors = 0;

    for (let i = 0; i < chainWallets.length; i++) {
      const wallet = chainWallets[i];

      // Per-chain fail-fast (mirrors activity-wallets-bg.js:295-304)
      if (consecutiveTimeouts >= perChainTimeoutLimit) {
        chainSkipped = chainWallets.length - i;
        this.logger.warn(
          `wallet-activity: ${chain} fail-fast (${consecutiveTimeouts} consecutive timeouts), skipping ${chainSkipped} remaining wallets`,
        );
        break;
      }

      try {
        const swaps = await this.fetchWalletActivity(wallet.address, chain, perFetchTimeoutMs);

        for (const swap of swaps) {
          const { inserted } = await this.signalsRepo.insertSignal(
            swap,
            wallet.address,
            wallet.score ?? null,
            wallet.label ?? null,
            chain,
          );
          if (inserted) chainSignals++;
        }
        consecutiveTimeouts = 0; // reset on success
      } catch (err) {
        if (isTimeoutError(err)) {
          consecutiveTimeouts++;
          chainTimeouts++;
          this.logger.warn(
            `wallet-activity: ${chain} fetch timeout for ${wallet.address} (consecutive: ${consecutiveTimeouts})`,
          );
        } else {
          consecutiveTimeouts = 0;
          chainErrors++;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(`wallet-activity: ${chain} fetch failed for ${wallet.address}: ${msg}`);
        }
      }

      // Rotation: advance last_checked_at EVEN on failure so a permanently
      // dead wallet doesn't block the queue (mirrors activity-wallets-bg.js:342-343).
      const now = new Date().toISOString();
      try {
        await this.walletsRepo.updateLastChecked(wallet.address, chain, now);
      } catch (updateErr) {
        const msg = updateErr instanceof Error ? updateErr.message : String(updateErr);
        this.logger.warn(`wallet-activity: ${chain} updateLastChecked failed for ${wallet.address}: ${msg}`);
      }
      chainChecked++;

      // Inter-wallet delay (skip after last wallet — mirrors activity-wallets-bg.js:346-348)
      if (i < chainWallets.length - 1) {
        await sleep(interWalletDelayMs);
      }
    }

    // Chain-dark detection (mirrors activity-wallets-bg.js:354-363)
    if (chainChecked > 0 && chainSignals === 0 && (chainTimeouts > 0 || chainErrors > 0)) {
      this.logger.warn(
        `wallet-activity: ${chain} chain dark — checked=${chainChecked} signals=0` +
          ` timeouts=${chainTimeouts} errors=${chainErrors}`,
      );
    }

    return {
      checked: chainChecked,
      signals: chainSignals,
      skipped: chainSkipped,
      timeouts: chainTimeouts,
      errors: chainErrors,
    };
  }

  /**
   * Fetch swap signals for a single wallet on a given chain.
   *
   * Routes to Helius for Solana, EvmExplorerAdapter for EVM chains.
   * Applies `AbortSignal.timeout(perFetchTimeoutMs)` to cap wall-clock time.
   *
   * Mirrors `fetchWalletActivity()` in `scripts/activity-wallets-bg.js:192-202`.
   *
   * @returns Array of swap signal inputs (may be empty if no swaps found).
   * @throws TimeoutError / AbortError if the fetch exceeds perFetchTimeoutMs.
   * @throws EvmExplorerApiKeyMissingError / HeliusApiKeyMissingError if keys absent.
   */
  private async fetchWalletActivity(
    address: string,
    chain: string,
    perFetchTimeoutMs: number,
  ): Promise<ReturnType<typeof extractEvmSwaps>> {
    const signal = AbortSignal.timeout(perFetchTimeoutMs);
    const stables = getStables(chain);
    const wrappedNative = getWrappedNative(chain);

    if (chain === 'solana') {
      let txs: Awaited<ReturnType<HeliusAdapter['getParsedTransactions']>>;
      try {
        txs = await this.helius.getParsedTransactions(address, { signal });
      } catch (err) {
        if (err instanceof HeliusApiKeyMissingError) {
          this.logger.debug(`wallet-activity: solana HELIUS_API_KEY not configured — skipping ${address}`);
          return [];
        }
        throw err;
      }
      if (!txs) return [];
      return extractSolanaSwaps(txs, address, stables, wrappedNative);
    }

    // EVM path
    let rows: Awaited<ReturnType<EvmExplorerAdapter['getTokenTx']>>;
    try {
      rows = await this.evmExplorer.getTokenTx(address, chain, { signal });
    } catch (err) {
      if (err instanceof EvmExplorerApiKeyMissingError || err instanceof EvmExplorerUnsupportedChainError) {
        this.logger.debug(
          `wallet-activity: ${chain} explorer not configured — skipping ${address}: ${(err as Error).message}`,
        );
        return [];
      }
      throw err;
    }
    if (!rows) return [];
    return extractEvmSwaps(rows, address, stables, wrappedNative);
  }

  /** Write the `last_activity_wallets_bg_at` health meta key. */
  private async writeHealthKey(): Promise<void> {
    await this.systemService.setMeta({
      key: 'last_activity_wallets_bg_at',
      value: new Date().toISOString(),
    });
  }
}
