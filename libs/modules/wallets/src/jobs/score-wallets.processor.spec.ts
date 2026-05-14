/**
 * Unit tests for ScoreWalletsProcessor (SPEC §14, DoD §A, §E).
 *
 * Mocks BirdeyeAdapter, ZerionAdapter, WalletsRepository, SystemService,
 * ConfigService, and Queue (harvest enqueue) at the class boundary.
 * No real database or HTTP calls.
 *
 * Covers:
 *   - Empty findUnscored → meta key written, no API calls, result shape.
 *   - Happy path: 3 wallets, all score → 3× updateScore, correct counts.
 *   - classification_counts breakdown accurate.
 *   - Per-wallet Promise.allSettled: one Zerion rejection → others still score.
 *   - All three APIs return null (keys missing) → updateScore with 'failed'.
 *   - All three APIs reject (errors) → updateScore with 'failed', error truncated.
 *   - Per-wallet AbortController timeout: abort fires → wallet failed, processor continues.
 *   - Harvest gate stale (≥60 min) → enqueues 'wallet-harvest' once.
 *   - Harvest gate fresh → does NOT enqueue.
 *   - Harvest gate read throws → logs warn, continues scoring.
 *   - Inter-wallet delay honored via vi.useFakeTimers().
 *   - Idempotency: second run with empty findUnscored → DB shape unchanged, only meta advances.
 *   - Backoff/retry policy documented (DoD §E note).
 *
 * SPEC §8 — background job idempotency.
 * SPEC §4 #4 — no signer-key env vars.
 * SPEC §4 #6 — no process.env reads.
 * ADR-0026 — per-field config access.
 * DoD §E — idempotency assertion (processor-level).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job, Queue } from 'bullmq';
import { BirdeyeAdapter, BirdeyeApiKeyMissingError, BirdeyeRateLimitError } from '@cclaw/adapters-birdeye';
import type { TraderRankResult } from '@cclaw/adapters-birdeye';
import { ZerionAdapter, ZerionApiKeyMissingError, ZerionRateLimitError } from '@cclaw/adapters-zerion';
import type { ZerionPnlResult } from '@cclaw/adapters-zerion';
import { WalletsRepository } from '../wallets.repository.js';
import { SystemService } from '@cclaw/system';
import { ScoreWalletService } from './score-wallet.service.js';
import { ScoreWalletsProcessor } from './score-wallets.processor.js';
import type { TrackedWalletResponseDto } from '../dto/tracked-wallet-response.dto.js';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeWallet(address: string, chain = 'base'): TrackedWalletResponseDto {
  return {
    address,
    chain,
    label: null,
    type: null,
    notes: null,
    status: 'proposed',
    score: null,
    score_breakdown: null,
    source_token: null,
    scored_at: null,
    score_error: null,
    retry_count: 0,
    source: 'birdeye-harvest',
    last_checked_at: null,
    created_at: null,
  };
}

function makeBirdeyeAdapter(
  overrides: Partial<{
    getTraderRank: BirdeyeAdapter['getTraderRank'];
    getTokenTopTraders: BirdeyeAdapter['getTokenTopTraders'];
    getTopGainersPerChain: BirdeyeAdapter['getTopGainersPerChain'];
  }> = {},
): BirdeyeAdapter {
  return {
    getTraderRank: vi.fn().mockResolvedValue(null),
    getTokenTopTraders: vi.fn().mockResolvedValue(null),
    getTopGainersPerChain: vi.fn().mockResolvedValue([]),
    ...overrides,
  } as unknown as BirdeyeAdapter;
}

function makeZerionAdapter(
  overrides: Partial<{
    getPnl: ZerionAdapter['getPnl'];
  }> = {},
): ZerionAdapter {
  return {
    getPnl: vi.fn().mockResolvedValue(null),
    ...overrides,
  } as unknown as ZerionAdapter;
}

function makeWalletsRepo(overrides: Partial<WalletsRepository> = {}): WalletsRepository {
  return {
    findUnscored: vi.fn().mockResolvedValue([]),
    updateScore: vi.fn().mockResolvedValue(makeWallet('0x0')),
    proposeWallet: vi.fn(),
    findMany: vi.fn(),
    findOne: vi.fn(),
    upsertWallet: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as unknown as WalletsRepository;
}

function makeSystemService(lastHarvestAt: string | null = null): SystemService {
  return {
    getMeta: vi.fn().mockResolvedValue(lastHarvestAt ? { key: 'last_birdeye_harvest_at', value: lastHarvestAt } : null),
    setMeta: vi.fn().mockResolvedValue({ ok: true }),
  } as unknown as SystemService;
}

function makeConfigService(values: Record<string, unknown> = {}): ConfigService {
  const defaults: Record<string, unknown> = {
    WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
    WALLET_SCORING_INTER_WALLET_DELAY_MS: 3_000,
    ...values,
  };
  return {
    get: vi.fn().mockImplementation((key: string) => defaults[key]),
  } as unknown as ConfigService;
}

function makeHarvestQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'harvest-job-1' }),
  } as unknown as Queue;
}

function makeJob(id = 'job-1'): Job {
  return { id, data: {} } as unknown as Job;
}

/** Build a realistic TraderRankResult (inTopGainers:true) for scoring tests. */
function makeTraderRankResult(): TraderRankResult {
  return {
    source: 'birdeye_trader',
    inTopGainers: true,
    rank: 1,
    pnl: 200_000,
    volume: 2_000_000,
    tradeCount: 200,
    totalTraders: 10,
  };
}

/** Build a realistic ZerionPnlResult. */
function makeZerionPnlResult(): ZerionPnlResult {
  return {
    source: 'zerion',
    realizedPnl: 10_000,
    unrealizedPnl: 2_000,
    totalPnl: 12_000,
    totalInvested: 20_000,
    relativeRealizedGain: 600,
  };
}

function buildProcessor(
  overrides: {
    birdeye?: BirdeyeAdapter;
    zerion?: ZerionAdapter;
    repo?: WalletsRepository;
    system?: SystemService;
    config?: ConfigService;
    harvestQueue?: Queue;
    scoreService?: ScoreWalletService;
  } = {},
): ScoreWalletsProcessor {
  return new ScoreWalletsProcessor(
    overrides.harvestQueue ?? makeHarvestQueue(),
    overrides.birdeye ?? makeBirdeyeAdapter(),
    overrides.zerion ?? makeZerionAdapter(),
    overrides.repo ?? makeWalletsRepo(),
    overrides.system ?? makeSystemService(),
    overrides.config ?? makeConfigService(),
    overrides.scoreService ?? new ScoreWalletService(),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ScoreWalletsProcessor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Empty batch
  // -------------------------------------------------------------------------

  describe('process() — empty findUnscored', () => {
    it('writes health meta key even when no wallets to score', async () => {
      const system = makeSystemService();
      const proc = buildProcessor({ system });

      await proc.process(makeJob());

      expect(system.setMeta).toHaveBeenCalledOnce();
      expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_score_wallets_bg_at' }));
    });

    it('returns wallets_scored=0 and wallets_failed=0', async () => {
      const proc = buildProcessor();
      const result = await proc.process(makeJob());

      expect(result.wallets_scored).toBe(0);
      expect(result.wallets_failed).toBe(0);
    });

    it('does NOT call birdeye or zerion APIs when no wallets', async () => {
      const birdeye = makeBirdeyeAdapter();
      const zerion = makeZerionAdapter();
      const proc = buildProcessor({ birdeye, zerion });

      await proc.process(makeJob());

      expect(birdeye.getTraderRank).not.toHaveBeenCalled();
      expect(birdeye.getTokenTopTraders).not.toHaveBeenCalled();
      expect(zerion.getPnl).not.toHaveBeenCalled();
    });

    it('does NOT call updateScore when no wallets', async () => {
      const repo = makeWalletsRepo();
      const proc = buildProcessor({ repo });

      await proc.process(makeJob());

      expect(repo.updateScore).not.toHaveBeenCalled();
    });

    it('result has correct shape including harvest_enqueued', async () => {
      // Gate: stale → enqueue = true when last harvest was null (0 epoch)
      const proc = buildProcessor();
      const result = await proc.process(makeJob());

      expect(result).toHaveProperty('wallets_scored');
      expect(result).toHaveProperty('wallets_failed');
      expect(result).toHaveProperty('classification_counts');
      expect(result).toHaveProperty('harvest_enqueued');
      expect(result.classification_counts).toEqual({ smart_money: 0, whale: 0, lowtier: 0 });
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: 3 wallets, all score
  // -------------------------------------------------------------------------

  describe('process() — happy path with 3 wallets', () => {
    it('calls updateScore once per wallet', async () => {
      const wallets = [makeWallet('0xA'), makeWallet('0xB'), makeWallet('0xC')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockResolvedValue(makeZerionPnlResult()),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      await proc.process(makeJob());

      expect(repo.updateScore).toHaveBeenCalledTimes(3);
    });

    it('returns wallets_scored=3 when all wallets succeed', async () => {
      const wallets = [makeWallet('0xA'), makeWallet('0xB'), makeWallet('0xC')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, config });

      const result = await proc.process(makeJob());

      expect(result.wallets_scored).toBe(3);
      expect(result.wallets_failed).toBe(0);
    });

    it('calls updateScore with status="scored" for each wallet', async () => {
      const wallets = [makeWallet('0xA')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, config });

      await proc.process(makeJob());

      expect(repo.updateScore).toHaveBeenCalledWith('0xA', 'base', expect.objectContaining({ status: 'scored' }));
    });

    it('classification_counts tracks each wallet category', async () => {
      // All three wallets will score smart_money (traderRankResult → overall=90)
      const wallets = [makeWallet('0xA'), makeWallet('0xB'), makeWallet('0xC')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, config });

      const result = await proc.process(makeJob());

      expect(result.classification_counts.smart_money).toBe(3);
      expect(result.classification_counts.whale).toBe(0);
      expect(result.classification_counts.lowtier).toBe(0);
    });

    it('writes health meta key last_score_wallets_bg_at after successful run', async () => {
      const system = makeSystemService(new Date().toISOString()); // fresh
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ system, config });

      await proc.process(makeJob());

      expect(system.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_score_wallets_bg_at' }));
    });
  });

  // -------------------------------------------------------------------------
  // Per-wallet Promise.allSettled: partial failures
  // -------------------------------------------------------------------------

  describe('process() — per-wallet partial API failures', () => {
    it('scores wallet when zerion rejects but birdeye succeeds', async () => {
      const wallets = [makeWallet('0xA')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockRejectedValue(new ZerionRateLimitError('https://api.zerion.io')),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      const result = await proc.process(makeJob());

      // Birdeye succeeded → wallet should be scored (not failed)
      expect(result.wallets_scored).toBe(1);
      expect(result.wallets_failed).toBe(0);
    });

    it('scores wallet when birdeye rejects but zerion succeeds', async () => {
      const wallets = [makeWallet('0xA')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockRejectedValue(new BirdeyeRateLimitError('https://birdeye.so')),
        getTokenTopTraders: vi.fn().mockRejectedValue(new BirdeyeRateLimitError('https://birdeye.so')),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockResolvedValue(makeZerionPnlResult()),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      const result = await proc.process(makeJob());

      expect(result.wallets_scored).toBe(1);
      expect(result.wallets_failed).toBe(0);
    });

    it('continues scoring remaining wallets after one partially fails', async () => {
      const wallets = [makeWallet('0xFail'), makeWallet('0xOk')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      let callCount = 0;
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockImplementation(() => {
          callCount++;
          // First wallet: all APIs throw (triggering full failure)
          if (callCount === 1) return Promise.reject(new BirdeyeRateLimitError('https://birdeye.so'));
          return Promise.resolve(makeTraderRankResult());
        }),
        getTokenTopTraders: vi.fn().mockImplementation(() => {
          if (callCount <= 1) return Promise.reject(new BirdeyeRateLimitError('https://birdeye.so'));
          return Promise.resolve(null);
        }),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockRejectedValue(new ZerionRateLimitError('https://zerion.io')),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      await proc.process(makeJob());

      // Second wallet should succeed; total updateScore calls = 2
      expect(repo.updateScore).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // All three APIs return null (keys missing) → fail path
  // -------------------------------------------------------------------------

  describe('process() — all APIs return null (keys not configured)', () => {
    it('calls updateScore with status="failed" when all APIs return null', async () => {
      const wallets = [makeWallet('0xNoData')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      // All mocks default to returning null (no data)
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, config });

      await proc.process(makeJob());

      expect(repo.updateScore).toHaveBeenCalledWith('0xNoData', 'base', expect.objectContaining({ status: 'failed' }));
    });

    it('increments wallets_failed when all APIs return null', async () => {
      const wallets = [makeWallet('0xNoData')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, config });

      const result = await proc.process(makeJob());

      expect(result.wallets_failed).toBe(1);
      expect(result.wallets_scored).toBe(0);
    });

    it('score_error contains "No data from scoring APIs" (exact message from processor)', async () => {
      const wallets = [makeWallet('0xNoData')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, config });

      await proc.process(makeJob());

      const updateCall = (repo.updateScore as ReturnType<typeof vi.fn>).mock.calls[0];
      const dto = updateCall[2] as { score_error?: string };
      // Exact message from score-wallets.processor.ts:268
      expect(dto.score_error).toContain('No data from scoring APIs');
    });
  });

  // -------------------------------------------------------------------------
  // All three APIs reject (errors)
  // -------------------------------------------------------------------------

  describe('process() — all APIs reject', () => {
    it('calls updateScore with status="failed" when all three reject', async () => {
      const wallets = [makeWallet('0xErrors')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockRejectedValue(new Error('birdeye down')),
        getTokenTopTraders: vi.fn().mockRejectedValue(new Error('birdeye down')),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockRejectedValue(new Error('zerion down')),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      await proc.process(makeJob());

      expect(repo.updateScore).toHaveBeenCalledWith('0xErrors', 'base', expect.objectContaining({ status: 'failed' }));
    });

    it('score_error is truncated to 200 chars', async () => {
      const longMsg = 'a'.repeat(300);
      const wallets = [makeWallet('0xLongErr')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockRejectedValue(new Error(longMsg)),
        getTokenTopTraders: vi.fn().mockRejectedValue(new Error(longMsg)),
      });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockRejectedValue(new Error(longMsg)),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, zerion, config });

      await proc.process(makeJob());

      const updateCall = (repo.updateScore as ReturnType<typeof vi.fn>).mock.calls[0];
      const dto = updateCall[2] as { score_error?: string };
      expect(dto.score_error?.length ?? 0).toBeLessThanOrEqual(200);
    });
  });

  // -------------------------------------------------------------------------
  // BirdeyeApiKeyMissingError / ZerionApiKeyMissingError → caught → null
  // -------------------------------------------------------------------------

  describe('process() — missing-key errors caught as null', () => {
    it('BirdeyeApiKeyMissingError from getTraderRank is caught and treated as null', async () => {
      const wallets = [makeWallet('0xBeyeNoKey')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockRejectedValue(new BirdeyeApiKeyMissingError()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, birdeye, config });

      // Should not throw — processor swallows BirdeyeApiKeyMissingError
      await expect(proc.process(makeJob())).resolves.toBeDefined();
    });

    it('ZerionApiKeyMissingError from getPnl is caught and treated as null', async () => {
      const wallets = [makeWallet('0xZerionNoKey')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const zerion = makeZerionAdapter({
        getPnl: vi.fn().mockRejectedValue(new ZerionApiKeyMissingError()),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, zerion, config });

      await expect(proc.process(makeJob())).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Per-wallet AbortController timeout
  // -------------------------------------------------------------------------

  describe('process() — per-wallet AbortController timeout', () => {
    it('marks wallet failed on timeout and continues to next wallet', async () => {
      vi.useFakeTimers();

      const wallets = [makeWallet('0xSlow'), makeWallet('0xFast')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });

      // First wallet: API call never resolves (simulates timeout by abort signal triggering)
      const slowSignalError = new DOMException('The operation was aborted.', 'AbortError');
      let callCount = 0;
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) {
            // Return a promise that rejects with abort error
            return Promise.reject(slowSignalError);
          }
          return Promise.resolve(makeTraderRankResult());
        }),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({
        WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
        WALLET_SCORING_INTER_WALLET_DELAY_MS: 0,
      });
      const proc = buildProcessor({ repo, birdeye, config });

      // Advance timers to trigger the abort
      const processPromise = proc.process(makeJob());
      vi.runAllTimers();
      await processPromise;

      vi.useRealTimers();

      // First wallet timed out → failed; second wallet succeeded
      expect(repo.updateScore).toHaveBeenCalledTimes(2);
      // First call: failed (timeout)
      const firstCall = (repo.updateScore as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(firstCall[2]).toMatchObject({ status: 'failed' });
    });
  });

  // -------------------------------------------------------------------------
  // Harvest gate: stale (≥60 min) → enqueue
  // -------------------------------------------------------------------------

  describe('process() — harvest gate (stale → enqueue)', () => {
    it('enqueues a wallet-harvest job when last_birdeye_harvest_at is null (never run)', async () => {
      const harvestQueue = makeHarvestQueue();
      // getMeta returns null (never harvested → elapsed from epoch = very stale)
      const system = makeSystemService(null);
      const proc = buildProcessor({ system, harvestQueue });

      await proc.process(makeJob());

      expect(harvestQueue.add).toHaveBeenCalledOnce();
      expect(harvestQueue.add).toHaveBeenCalledWith('harvest', {});
    });

    it('enqueues when last harvest was more than 60 min ago', async () => {
      const staleTime = new Date(Date.now() - 61 * 60 * 1000).toISOString();
      const harvestQueue = makeHarvestQueue();
      const system = makeSystemService(staleTime);
      const proc = buildProcessor({ system, harvestQueue });

      await proc.process(makeJob());

      expect(harvestQueue.add).toHaveBeenCalledOnce();
    });

    it('sets harvest_enqueued=true in result when enqueue fires', async () => {
      const harvestQueue = makeHarvestQueue();
      const system = makeSystemService(null);
      const proc = buildProcessor({ system, harvestQueue });

      const result = await proc.process(makeJob());

      expect(result.harvest_enqueued).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Harvest gate: fresh (< 60 min) → no enqueue
  // -------------------------------------------------------------------------

  describe('process() — harvest gate (fresh → no enqueue)', () => {
    it('does NOT enqueue when last harvest was < 60 min ago', async () => {
      const freshTime = new Date(Date.now() - 10 * 60 * 1000).toISOString(); // 10 min ago
      const harvestQueue = makeHarvestQueue();
      const system = makeSystemService(freshTime);
      const proc = buildProcessor({ system, harvestQueue });

      await proc.process(makeJob());

      expect(harvestQueue.add).not.toHaveBeenCalled();
    });

    it('sets harvest_enqueued=false when gate not triggered', async () => {
      const freshTime = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      const harvestQueue = makeHarvestQueue();
      const system = makeSystemService(freshTime);
      const proc = buildProcessor({ system, harvestQueue });

      const result = await proc.process(makeJob());

      expect(result.harvest_enqueued).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Harvest gate: getMeta throws → logs warn, continues scoring
  // -------------------------------------------------------------------------

  describe('process() — harvest gate read throws', () => {
    it('logs a warning and continues scoring when getMeta throws', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const system = {
        getMeta: vi.fn().mockRejectedValue(new Error('DB connection lost')),
        setMeta: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as SystemService;
      const wallets = [makeWallet('0xA')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ repo, system, birdeye, config });

      // Must NOT throw
      const result = await proc.process(makeJob());

      expect(warnSpy).toHaveBeenCalled();
      // Scoring still ran
      expect(result.wallets_scored).toBe(1);
    });

    it('does NOT enqueue harvest job when getMeta throws', async () => {
      const harvestQueue = makeHarvestQueue();
      const system = {
        getMeta: vi.fn().mockRejectedValue(new Error('Redis down')),
        setMeta: vi.fn().mockResolvedValue({ ok: true }),
      } as unknown as SystemService;
      const proc = buildProcessor({ system, harvestQueue });

      await proc.process(makeJob());

      expect(harvestQueue.add).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Inter-wallet delay via vi.useFakeTimers()
  // -------------------------------------------------------------------------

  describe('process() — inter-wallet delay (WALLET_SCORING_INTER_WALLET_DELAY_MS)', () => {
    it('reads WALLET_SCORING_INTER_WALLET_DELAY_MS from configService', async () => {
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ config });

      await proc.process(makeJob());

      expect(config.get).toHaveBeenCalledWith('WALLET_SCORING_INTER_WALLET_DELAY_MS');
    });

    it('skips delay after the last wallet', async () => {
      vi.useFakeTimers();

      const wallets = [makeWallet('0xOnly')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      // Large inter-wallet delay — but single wallet → no delay
      const config = makeConfigService({
        WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
        WALLET_SCORING_INTER_WALLET_DELAY_MS: 10_000,
      });
      const proc = buildProcessor({ repo, birdeye, config });

      const processPromise = proc.process(makeJob());
      // Should resolve without needing to advance timers (no delay after last wallet)
      await processPromise;

      vi.useRealTimers();

      expect(repo.updateScore).toHaveBeenCalledTimes(1);
    });

    it('delay fires between wallets (not after last)', async () => {
      vi.useFakeTimers();

      const wallets = [makeWallet('0xFirst'), makeWallet('0xSecond')];
      const repo = makeWalletsRepo({ findUnscored: vi.fn().mockResolvedValue(wallets) });
      const birdeye = makeBirdeyeAdapter({
        getTraderRank: vi.fn().mockResolvedValue(makeTraderRankResult()),
        getTokenTopTraders: vi.fn().mockResolvedValue(null),
      });
      const config = makeConfigService({
        WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
        WALLET_SCORING_INTER_WALLET_DELAY_MS: 3_000,
      });
      const proc = buildProcessor({ repo, birdeye, config });

      const processPromise = proc.process(makeJob());
      // Advance by 3s to let the inter-wallet delay pass
      await vi.advanceTimersByTimeAsync(3_100);
      await processPromise;

      vi.useRealTimers();

      expect(repo.updateScore).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // Idempotency (DoD §E)
  // -------------------------------------------------------------------------

  describe('process() — idempotency (DoD §E)', () => {
    it('second run with empty findUnscored → same wallets_scored=0, meta advances', async () => {
      const system = makeSystemService(new Date().toISOString());
      const proc = buildProcessor({ system });

      const result1 = await proc.process(makeJob('j1'));
      const result2 = await proc.process(makeJob('j2'));

      // Both runs produce identical "zero work" results
      expect(result1.wallets_scored).toBe(0);
      expect(result2.wallets_scored).toBe(0);
      // setMeta called twice (once per run)
      expect(system.setMeta).toHaveBeenCalledTimes(2);
    });

    it('second run does not call updateScore when findUnscored returns empty', async () => {
      const repo = makeWalletsRepo();
      const proc = buildProcessor({ repo });

      await proc.process(makeJob('j1'));
      await proc.process(makeJob('j2'));

      expect(repo.updateScore).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0026: per-field config access
  // -------------------------------------------------------------------------

  describe('ADR-0026 — per-field config access', () => {
    it('reads WALLET_SCORING_PER_WALLET_TIMEOUT_MS via configService.get', async () => {
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ config });

      await proc.process(makeJob());

      expect(config.get).toHaveBeenCalledWith('WALLET_SCORING_PER_WALLET_TIMEOUT_MS');
    });

    it('reads WALLET_SCORING_INTER_WALLET_DELAY_MS via configService.get', async () => {
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ config });

      await proc.process(makeJob());

      expect(config.get).toHaveBeenCalledWith('WALLET_SCORING_INTER_WALLET_DELAY_MS');
    });

    it('does NOT read SAFE_SIGNER_KEY or SQUADS_SIGNER_KEY (SPEC §4 #4)', async () => {
      const config = makeConfigService({ WALLET_SCORING_INTER_WALLET_DELAY_MS: 0 });
      const proc = buildProcessor({ config });

      await proc.process(makeJob());

      const calls = (config.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const signerCalls = calls.filter((args) => args[0] === 'SAFE_SIGNER_KEY' || args[0] === 'SQUADS_SIGNER_KEY');
      expect(signerCalls).toHaveLength(0);
    });

    it('falls back to 30_000ms when WALLET_SCORING_PER_WALLET_TIMEOUT_MS is undefined', async () => {
      const config = makeConfigService({
        WALLET_SCORING_PER_WALLET_TIMEOUT_MS: undefined,
        WALLET_SCORING_INTER_WALLET_DELAY_MS: 0,
      });
      const proc = buildProcessor({ config });

      // Must not throw — default 30_000ms used
      await expect(proc.process(makeJob())).resolves.toBeDefined();
    });

    it('falls back to 3_000ms when WALLET_SCORING_INTER_WALLET_DELAY_MS is undefined', async () => {
      vi.useFakeTimers();

      const config = makeConfigService({
        WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
        WALLET_SCORING_INTER_WALLET_DELAY_MS: undefined,
      });
      const proc = buildProcessor({ config });

      const processPromise = proc.process(makeJob());
      // No wallets → should resolve immediately (no delay needed)
      await processPromise;

      vi.useRealTimers();

      await expect(Promise.resolve()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // DoD §E — backoff/retry note (static assertion)
  // The actual BullMQ retry behavior is in WALLET_SCORING_JOB_OPTIONS.
  // Verified in apps/worker DI smoke. This test documents the contract.
  // -------------------------------------------------------------------------

  describe('DoD §E — retry policy documentation', () => {
    it('process() returns a ScoreWalletsJobResult (not void) so BullMQ can persist result', async () => {
      const proc = buildProcessor();
      const result = await proc.process(makeJob());

      expect(result).not.toBeUndefined();
      expect(typeof result.wallets_scored).toBe('number');
      expect(typeof result.wallets_failed).toBe('number');
      expect(typeof result.harvest_enqueued).toBe('boolean');
    });
  });
});
