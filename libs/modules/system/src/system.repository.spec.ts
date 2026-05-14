import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SystemRepository } from './system.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const mockFindUnique = vi.fn();
const mockFindMany = vi.fn();
const mockUpsert = vi.fn();
const mockSyncFindMany = vi.fn();

const mockPrisma = {
  portfolioMeta: {
    findUnique: mockFindUnique,
    findMany: mockFindMany,
    upsert: mockUpsert,
  },
  portfolioSync: {
    findMany: mockSyncFindMany,
  },
} as unknown as PrismaService;

describe('SystemRepository', () => {
  let repo: SystemRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new SystemRepository(mockPrisma);
  });

  describe('getMeta()', () => {
    it('returns key/value when row exists', async () => {
      mockFindUnique.mockResolvedValue({ key: 'safe_id', value: 'my-fund', updatedAt: null });
      const result = await repo.getMeta('safe_id');
      expect(result).toEqual({ key: 'safe_id', value: 'my-fund' });
    });

    it('returns null value when key missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await repo.getMeta('missing_key');
      expect(result).toEqual({ key: 'missing_key', value: null });
    });
  });

  describe('setMeta()', () => {
    it('calls upsert and returns ok', async () => {
      mockUpsert.mockResolvedValue({ key: 'test_key', value: 'test_val', updatedAt: null });
      const result = await repo.setMeta({ key: 'test_key', value: 'test_val' });
      expect(mockUpsert).toHaveBeenCalledWith({
        where: { key: 'test_key' },
        create: { key: 'test_key', value: 'test_val' },
        update: { value: 'test_val' },
      });
      expect(result).toEqual({ ok: true, key: 'test_key', value: 'test_val' });
    });
  });

  describe('getCashByChain()', () => {
    it('returns chain/cash from meta key cash_base', async () => {
      mockFindUnique.mockResolvedValue({ key: 'cash_base', value: '1000.5', updatedAt: null });
      const result = await repo.getCashByChain('base');
      expect(mockFindUnique).toHaveBeenCalledWith({ where: { key: 'cash_base' } });
      expect(result).toEqual({ chain: 'base', cash: 1000.5 });
    });

    it('returns 0 when key missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await repo.getCashByChain('solana');
      expect(result).toEqual({ chain: 'solana', cash: 0 });
    });
  });

  describe('getAllCash()', () => {
    it('builds flat breakdown from cash_ keys', async () => {
      mockFindMany.mockResolvedValue([
        { key: 'cash_base', value: '500' },
        { key: 'cash_solana', value: '250' },
      ]);
      const result = await repo.getAllCash();
      expect(result['base']).toBe(500);
      expect(result['solana']).toBe(250);
      expect(result['total']).toBe(750);
    });

    it('skips exact cash_ key (no chain suffix)', async () => {
      mockFindMany.mockResolvedValue([
        { key: 'cash_', value: '999' }, // should be skipped
        { key: 'cash_base', value: '100' },
      ]);
      const result = await repo.getAllCash();
      expect(result['base']).toBe(100);
      expect(result['']).toBeUndefined();
    });
  });

  describe('setCash()', () => {
    it('upserts cash_<chain> key and returns correct shape', async () => {
      mockUpsert.mockResolvedValue({ key: 'cash_base', value: '500', updatedAt: null });
      const result = await repo.setCash({ chain: 'base', amount: 500 });
      expect(mockUpsert).toHaveBeenCalledWith({
        where: { key: 'cash_base' },
        create: { key: 'cash_base', value: '500' },
        update: { value: '500' },
      });
      expect(result).toEqual({ ok: true, chain: 'base', cash: 500 });
    });

    it('accepts zero amount (boundary — @Min(0) allows 0)', async () => {
      mockUpsert.mockResolvedValue({ key: 'cash_base', value: '0', updatedAt: null });
      const result = await repo.setCash({ chain: 'base', amount: 0 });
      expect(mockUpsert).toHaveBeenCalledWith({
        where: { key: 'cash_base' },
        create: { key: 'cash_base', value: '0' },
        update: { value: '0' },
      });
      expect(result).toEqual({ ok: true, chain: 'base', cash: 0 });
    });
  });

  describe('getGas()', () => {
    it('returns parsed gas info when key exists', async () => {
      mockFindUnique.mockResolvedValue({
        key: 'gas_base',
        value: JSON.stringify({ symbol: 'ETH', balance: 0.1, price: 3000, value_usd: 300 }),
      });
      const result = await repo.getGas('base');
      expect(result).toEqual({ chain: 'base', symbol: 'ETH', balance: 0.1, price: 3000, value_usd: 300 });
    });

    it('returns zero defaults when key missing', async () => {
      mockFindUnique.mockResolvedValue(null);
      const result = await repo.getGas('solana');
      expect(result).toEqual({ chain: 'solana', symbol: null, balance: 0, price: 0, value_usd: 0 });
    });

    it('returns partial defaults when gas JSON has missing fields (exercises ?? branches)', async () => {
      // Parsed JSON with only symbol — balance/price/value_usd are undefined → default to 0
      mockFindUnique.mockResolvedValue({
        key: 'gas_base',
        value: JSON.stringify({ symbol: 'ETH' }),
      });
      const result = await repo.getGas('base');
      expect(result).toEqual({ chain: 'base', symbol: 'ETH', balance: 0, price: 0, value_usd: 0 });
    });

    it('returns null symbol when gas JSON has no symbol field', async () => {
      mockFindUnique.mockResolvedValue({
        key: 'gas_base',
        value: JSON.stringify({ balance: 1.0, price: 3000, value_usd: 3000 }),
      });
      const result = await repo.getGas('base');
      expect(result.symbol).toBeNull();
      expect(result.balance).toBe(1.0);
    });

    // Coder-flagged uncertainty #3: malformed JSON in gas_ meta value must not crash
    it('throws when gas value is malformed JSON (SyntaxError propagates)', async () => {
      mockFindUnique.mockResolvedValue({
        key: 'gas_base',
        value: 'not-valid-json',
      });
      // Current implementation calls JSON.parse directly — it will throw SyntaxError.
      // The test documents this behavior so the coder can decide whether to add a
      // try/catch (graceful zeros) or let it propagate as a 500.
      // [OPEN-1] If the decision is graceful zeros, add try/catch in getGas() and
      // update this test to assert the zero-defaults shape instead.
      await expect(repo.getGas('base')).rejects.toThrow(SyntaxError);
    });
  });

  describe('getSyncStatus()', () => {
    const makeRow = (id: number) => ({
      id,
      chain: 'base',
      provider: 'debank',
      trigger: 'manual',
      status: 'success',
      positionsSynced: 5,
      positionsClosed: 0,
      positionsDiscovered: 2,
      error: null,
      syncedAt: '2026-05-14 10:00:00',
    });

    it('queries with chain filter and correct limit', async () => {
      mockSyncFindMany.mockResolvedValue([makeRow(1)]);
      const result = await repo.getSyncStatus({ chain: 'base', limit: 5 });
      expect(mockSyncFindMany).toHaveBeenCalledWith({
        where: { chain: 'base' },
        orderBy: { syncedAt: 'desc' },
        take: 5,
      });
      expect(result[0]!.id).toBe(1);
      expect(result[0]!.positions_synced).toBe(5);
    });

    it('omits where clause when no chain given', async () => {
      mockSyncFindMany.mockResolvedValue([makeRow(1)]);
      await repo.getSyncStatus({ limit: 20 });
      const call = mockSyncFindMany.mock.calls[0][0] as { where: unknown };
      expect(call.where).toBeUndefined();
    });

    it('caps limit at 100', async () => {
      mockSyncFindMany.mockResolvedValue([]);
      await repo.getSyncStatus({ limit: 999 });
      const call = mockSyncFindMany.mock.calls[0][0] as { take: number };
      expect(call.take).toBe(100);
    });

    it('defaults limit to 20', async () => {
      mockSyncFindMany.mockResolvedValue([]);
      await repo.getSyncStatus({});
      const call = mockSyncFindMany.mock.calls[0][0] as { take: number };
      expect(call.take).toBe(20);
    });

    it('maps null error and null syncedAt to null in response (exercises ?? null branches)', async () => {
      // Exercises error ?? null and syncedAt ?? null in mapSync()
      mockSyncFindMany.mockResolvedValue([
        {
          id: 5,
          chain: 'solana',
          provider: 'helius',
          trigger: 'heartbeat',
          status: 'success',
          positionsSynced: 0,
          positionsClosed: 0,
          positionsDiscovered: 0,
          error: null,
          syncedAt: null,
        },
      ]);
      const result = await repo.getSyncStatus({ limit: 10 });
      expect(result[0]!.error).toBeNull();
      expect(result[0]!.synced_at).toBeNull();
    });

    it('maps non-null error and syncedAt when present', async () => {
      // Exercises the non-null branch of error ?? null and syncedAt ?? null
      mockSyncFindMany.mockResolvedValue([
        {
          id: 6,
          chain: 'base',
          provider: 'debank',
          trigger: 'manual',
          status: 'error',
          positionsSynced: 0,
          positionsClosed: 0,
          positionsDiscovered: 0,
          error: 'RPC timeout',
          syncedAt: '2026-05-14 10:00:00',
        },
      ]);
      const result = await repo.getSyncStatus({ limit: 10 });
      expect(result[0]!.error).toBe('RPC timeout');
      expect(result[0]!.synced_at).toBe('2026-05-14 10:00:00');
    });
  });
});
