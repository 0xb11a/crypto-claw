/**
 * Unit tests for HarvestProcessor (SPEC §14, DoD §A, §E).
 *
 * Mocks BirdeyeAdapter, WalletsRepository, SystemService at the class boundary.
 * No real database or HTTP calls.
 *
 * Covers:
 *   - Happy path: adapter returns N tokens → proposeWallet called N× → correct result shape.
 *   - Meta write: system.setMeta('last_birdeye_harvest_at', ...) called once per run.
 *   - Empty result: adapter returns [] → proposeWallet NOT called → harvested:0 → meta written.
 *   - Per-token error: proposeWallet throws for one token → processor logs, continues, counts only successes.
 *   - Adapter throws (BirdeyeApiKeyMissingError): propagates so BullMQ can retry.
 *   - ACTIVE_CHAINS empty: skips fetch, returns {harvested:0} and still writes meta.
 *   - WALLET_HARVEST_TIMEOUT_MS honored: getTopGainersPerChain called with an AbortSignal.
 *   - byChain breakdown matches actual inserts.
 *   - dedup note: proposeWallet called per token (INSERT OR IGNORE is repo responsibility).
 *
 * SPEC §8 — background job idempotency guarantee.
 * ADR-0026 — per-field config access only.
 * DoD §E — idempotency: run twice, same DB shape (tested in integration spec).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import type { BirdeyeAdapter } from '@cclaw/adapters-birdeye';
import { BirdeyeApiKeyMissingError } from '@cclaw/adapters-birdeye';
import { HarvestProcessor } from './harvest.processor.js';
import type { WalletsRepository } from '../wallets.repository.js';
import type { SystemService } from '@cclaw/system';

// ---------------------------------------------------------------------------
// Factory helpers
// ---------------------------------------------------------------------------

function makeAdapter(overrides?: Partial<BirdeyeAdapter>): BirdeyeAdapter {
  return {
    getTopGainersPerChain: vi.fn().mockResolvedValue([]),
    getTraderRank: vi.fn(),
    getTokenTopTraders: vi.fn(),
    ...overrides,
  } as unknown as BirdeyeAdapter;
}

function makeRepo(overrides?: Partial<WalletsRepository>): WalletsRepository {
  return {
    proposeWallet: vi
      .fn()
      .mockResolvedValue({ ok: true, address: '0x', status: 'proposed', source: 'birdeye-harvest' }),
    findMany: vi.fn(),
    findOne: vi.fn(),
    upsertWallet: vi.fn(),
    findUnscored: vi.fn(),
    updateScore: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  } as unknown as WalletsRepository;
}

function makeSystemService(overrides?: Partial<SystemService>): SystemService {
  return {
    setMeta: vi.fn().mockResolvedValue({ ok: true, key: 'last_birdeye_harvest_at', value: '' }),
    getMeta: vi.fn(),
    ...overrides,
  } as unknown as SystemService;
}

function makeConfigService(values: Record<string, unknown>): ConfigService {
  return {
    get: vi.fn().mockImplementation((key: string) => values[key]),
  } as unknown as ConfigService;
}

function makeJob(id = 'job-1'): Job {
  return { id, data: {} } as unknown as Job;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('HarvestProcessor', () => {
  let adapter: BirdeyeAdapter;
  let repo: WalletsRepository;
  let systemService: SystemService;
  let configService: ConfigService;
  let processor: HarvestProcessor;

  const DEFAULT_CONFIG = {
    ACTIVE_CHAINS: 'base,solana',
    WALLET_HARVEST_TIMEOUT_MS: 300_000,
  };

  beforeEach(() => {
    adapter = makeAdapter();
    repo = makeRepo();
    systemService = makeSystemService();
    configService = makeConfigService(DEFAULT_CONFIG);
    processor = new HarvestProcessor(adapter, repo, systemService, configService);
    // Suppress logger output in tests
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('process() — happy path', () => {
    it('returns harvested count equal to number of tokens returned by adapter', async () => {
      const tokens = [
        { address: '0xA', chain: 'base', symbol: 'TKNA' },
        { address: '0xB', chain: 'base', symbol: 'TKNB' },
        { address: 'SolAddr', chain: 'solana', symbol: 'SOLS' },
      ];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      const result = await processor.process(makeJob());

      expect(result.harvested).toBe(3);
    });

    it('calls proposeWallet once per token', async () => {
      const tokens = [
        { address: '0xA', chain: 'base', symbol: 'TKNA' },
        { address: '0xB', chain: 'base', symbol: 'TKNB' },
      ];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      expect(repo.proposeWallet).toHaveBeenCalledTimes(2);
    });

    it('calls proposeWallet with source="birdeye-harvest"', async () => {
      const tokens = [{ address: '0xA', chain: 'base', symbol: 'A' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      expect(repo.proposeWallet).toHaveBeenCalledWith(expect.objectContaining({ source: 'birdeye-harvest' }));
    });

    it('returns byChain breakdown grouped correctly', async () => {
      const tokens = [
        { address: '0xA', chain: 'base', symbol: 'A' },
        { address: '0xB', chain: 'base', symbol: 'B' },
        { address: 'SolA', chain: 'solana', symbol: 'SA' },
      ];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      const result = await processor.process(makeJob());

      expect(result.byChain['base']).toBe(2);
      expect(result.byChain['solana']).toBe(1);
    });

    it('calls systemService.setMeta with "last_birdeye_harvest_at" exactly once', async () => {
      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledOnce();
      expect(systemService.setMeta).toHaveBeenCalledWith(expect.objectContaining({ key: 'last_birdeye_harvest_at' }));
    });

    it('setMeta value is a recent ISO timestamp', async () => {
      const before = Date.now();

      await processor.process(makeJob());

      const after = Date.now();
      const call = (systemService.setMeta as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        key: string;
        value: string;
      };
      const ts = new Date(call.value).getTime();
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after + 100);
    });
  });

  // -------------------------------------------------------------------------
  // Empty adapter result
  // -------------------------------------------------------------------------

  describe('process() — adapter returns []', () => {
    it('returns harvested:0 and empty byChain', async () => {
      const result = await processor.process(makeJob());

      expect(result.harvested).toBe(0);
      expect(result.byChain).toEqual({});
    });

    it('does NOT call proposeWallet', async () => {
      await processor.process(makeJob());

      expect(repo.proposeWallet).not.toHaveBeenCalled();
    });

    it('still calls setMeta even when harvested:0', async () => {
      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE_CHAINS empty
  // -------------------------------------------------------------------------

  describe('process() — ACTIVE_CHAINS is empty', () => {
    it('skips fetch and returns harvested:0 when ACTIVE_CHAINS is empty string', async () => {
      configService = makeConfigService({ ACTIVE_CHAINS: '', WALLET_HARVEST_TIMEOUT_MS: 300_000 });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      const result = await processor.process(makeJob());

      expect(result.harvested).toBe(0);
      expect(adapter.getTopGainersPerChain).not.toHaveBeenCalled();
    });

    it('still writes meta when ACTIVE_CHAINS is empty', async () => {
      configService = makeConfigService({ ACTIVE_CHAINS: '', WALLET_HARVEST_TIMEOUT_MS: 300_000 });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledOnce();
    });

    it('filters blank entries from comma-separated ACTIVE_CHAINS', async () => {
      // e.g. "base, ,solana" → ['base', 'solana'] after trim+filter
      configService = makeConfigService({ ACTIVE_CHAINS: 'base, ,solana', WALLET_HARVEST_TIMEOUT_MS: 300_000 });
      const tokens = [{ address: '0xA', chain: 'base', symbol: 'A' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      // getTopGainersPerChain is called with the filtered chain list
      const callArgs = (adapter.getTopGainersPerChain as ReturnType<typeof vi.fn>).mock.calls[0];
      const chains = callArgs[0] as string[];
      expect(chains).not.toContain('');
    });
  });

  // -------------------------------------------------------------------------
  // Per-token error handling
  // -------------------------------------------------------------------------

  describe('process() — per-token error handling', () => {
    it('continues inserting remaining tokens when one proposeWallet call throws', async () => {
      const tokens = [
        { address: '0xFail', chain: 'base', symbol: 'FAIL' },
        { address: '0xOk', chain: 'base', symbol: 'OK' },
      ];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      repo = makeRepo({
        proposeWallet: vi
          .fn()
          .mockRejectedValueOnce(new Error('DB constraint violation'))
          .mockResolvedValueOnce({ ok: true, address: '0xOk', status: 'proposed', source: 'birdeye-harvest' }),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      const result = await processor.process(makeJob());

      // Only the successful insert counts
      expect(result.harvested).toBe(1);
      // Both tokens were attempted
      expect(repo.proposeWallet).toHaveBeenCalledTimes(2);
    });

    it('logs a warning for the failed token (observable)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      const tokens = [{ address: '0xFail', chain: 'base', symbol: 'FAIL' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      repo = makeRepo({
        proposeWallet: vi.fn().mockRejectedValueOnce(new Error('insert failed')),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      expect(warnSpy).toHaveBeenCalled();
    });

    it('still calls setMeta even when some tokens fail', async () => {
      const tokens = [{ address: '0xFail', chain: 'base', symbol: 'FAIL' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      repo = makeRepo({
        proposeWallet: vi.fn().mockRejectedValueOnce(new Error('db error')),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      expect(systemService.setMeta).toHaveBeenCalledOnce();
    });
  });

  // -------------------------------------------------------------------------
  // Adapter throws — propagates for BullMQ retry
  // -------------------------------------------------------------------------

  describe('process() — adapter throws', () => {
    it('propagates BirdeyeApiKeyMissingError so BullMQ can retry', async () => {
      adapter = makeAdapter({
        getTopGainersPerChain: vi.fn().mockRejectedValue(new BirdeyeApiKeyMissingError()),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await expect(processor.process(makeJob())).rejects.toThrow(BirdeyeApiKeyMissingError);
    });

    it('does NOT call setMeta when adapter throws (retry must re-run cleanly)', async () => {
      adapter = makeAdapter({
        getTopGainersPerChain: vi.fn().mockRejectedValue(new Error('network error')),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob()).catch(() => {});

      expect(systemService.setMeta).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AbortSignal / WALLET_HARVEST_TIMEOUT_MS
  // -------------------------------------------------------------------------

  describe('process() — WALLET_HARVEST_TIMEOUT_MS honored', () => {
    it('calls getTopGainersPerChain with an AbortSignal in opts', async () => {
      await processor.process(makeJob());

      const callArgs = (adapter.getTopGainersPerChain as ReturnType<typeof vi.fn>).mock.calls[0];
      const opts = callArgs[1] as { signal?: AbortSignal };
      expect(opts?.signal).toBeDefined();
      expect(opts?.signal instanceof AbortSignal).toBe(true);
    });

    it('uses WALLET_HARVEST_TIMEOUT_MS from configService (not a hardcoded default only)', async () => {
      const customTimeout = 60_000;
      configService = makeConfigService({
        ACTIVE_CHAINS: 'base',
        WALLET_HARVEST_TIMEOUT_MS: customTimeout,
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      // The configService.get for WALLET_HARVEST_TIMEOUT_MS was called
      expect(configService.get).toHaveBeenCalledWith('WALLET_HARVEST_TIMEOUT_MS');
    });

    it('falls back to 300_000 ms when WALLET_HARVEST_TIMEOUT_MS is absent', async () => {
      // configService.get returns undefined for WALLET_HARVEST_TIMEOUT_MS
      configService = makeConfigService({ ACTIVE_CHAINS: 'base', WALLET_HARVEST_TIMEOUT_MS: undefined });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      // Should not throw — default is used
      await expect(processor.process(makeJob())).resolves.toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // Dedup note: processor calls proposeWallet for every token from adapter;
  // INSERT OR IGNORE is enforced at the repository layer (not the processor).
  // This test documents the contract boundary.
  // -------------------------------------------------------------------------

  describe('process() — dedup responsibility boundary', () => {
    it('calls proposeWallet for each token even if addresses repeat', async () => {
      // Adapter returns two tokens with same address (would be a Birdeye quirk)
      const tokens = [
        { address: '0xDup', chain: 'base', symbol: 'DUP' },
        { address: '0xDup', chain: 'base', symbol: 'DUP' },
      ];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      // Processor calls repo twice — repo enforces INSERT OR IGNORE (idempotency)
      expect(repo.proposeWallet).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // ACTIVE_CHAINS: splits and trims correctly
  // -------------------------------------------------------------------------

  describe('process() — ACTIVE_CHAINS parsing', () => {
    it('trims whitespace from chain names', async () => {
      configService = makeConfigService({
        ACTIVE_CHAINS: ' base , solana ',
        WALLET_HARVEST_TIMEOUT_MS: 300_000,
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      const callArgs = (adapter.getTopGainersPerChain as ReturnType<typeof vi.fn>).mock.calls[0];
      const chains = callArgs[0] as string[];
      expect(chains).toContain('base');
      expect(chains).toContain('solana');
      expect(chains).not.toContain(' base ');
    });
  });

  // -------------------------------------------------------------------------
  // Branch coverage: uncovered defensive paths
  // -------------------------------------------------------------------------

  describe('process() — defensive branch coverage', () => {
    it('handles job.id=undefined gracefully (logs n/a instead of throwing)', async () => {
      const jobWithNoId = { data: {} } as unknown as Job; // no id property
      // Should not throw even when job.id is undefined
      await expect(processor.process(jobWithNoId)).resolves.toBeDefined();
    });

    it('handles ACTIVE_CHAINS=undefined from configService (defaults to empty → skips fetch)', async () => {
      // configService.get returns undefined for ACTIVE_CHAINS
      configService = makeConfigService({ ACTIVE_CHAINS: undefined, WALLET_HARVEST_TIMEOUT_MS: 300_000 });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      const result = await processor.process(makeJob());

      // undefined → coalesces to '' → no chains → skips fetch
      expect(result.harvested).toBe(0);
      expect(adapter.getTopGainersPerChain).not.toHaveBeenCalled();
    });

    it('uses empty string label (undefined) when token.symbol is empty string', async () => {
      // symbol='' is falsy → processor passes label=undefined to proposeWallet
      const tokens = [{ address: '0xNoSym', chain: 'base', symbol: '' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      await processor.process(makeJob());

      const call = (repo.proposeWallet as ReturnType<typeof vi.fn>).mock.calls[0][0] as { label?: string };
      expect(call.label).toBeUndefined();
    });

    it('handles non-Error exception in proposeWallet (string thrown)', async () => {
      // Exercises the `err instanceof Error ? ... : String(err)` branch
      const tokens = [{ address: '0xStrErr', chain: 'base', symbol: 'SE' }];
      adapter = makeAdapter({ getTopGainersPerChain: vi.fn().mockResolvedValue(tokens) });
      repo = makeRepo({
        proposeWallet: vi.fn().mockRejectedValueOnce('plain string error'),
      });
      processor = new HarvestProcessor(adapter, repo, systemService, configService);

      // Should not throw — catches and logs the non-Error value
      const result = await processor.process(makeJob());

      expect(result.harvested).toBe(0);
    });
  });
});
