import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AnalysisCacheRepository } from './analysis-cache.repository.js';
import type { PrismaService } from '@cclaw/prisma';

// ---------------------------------------------------------------------------
// Minimal mock — only the methods the repository touches
// ---------------------------------------------------------------------------
const mockQueryRawUnsafe = vi.fn();
const mockExecuteRawUnsafe = vi.fn();
const mockFindUnique = vi.fn();

const mockPrisma = {
  $queryRawUnsafe: mockQueryRawUnsafe,
  $executeRawUnsafe: mockExecuteRawUnsafe,
  analysisCache: { findUnique: mockFindUnique },
} as unknown as PrismaService;

const makeRow = (overrides: Partial<Record<string, unknown>> = {}) => ({
  address: '0xtoken',
  chain: 'base',
  symbol: 'TKN',
  analysisScore: 75,
  riskScore: 30,
  verdict: 'buy',
  tier: 'moonshot',
  reasoning: 'test',
  expiresAt: '2099-01-01 00:00:00',
  createdAt: '2026-05-14 10:00:00',
  ...overrides,
});

describe('AnalysisCacheRepository', () => {
  let repo: AnalysisCacheRepository;

  beforeEach(() => {
    vi.clearAllMocks();
    repo = new AnalysisCacheRepository(mockPrisma);
  });

  describe('upsert', () => {
    it('calls $queryRawUnsafe with correct SQL and then findUnique', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      mockFindUnique.mockResolvedValue(makeRow());

      const result = await repo.upsert({
        address: '0xtoken',
        chain: 'base',
        verdict: 'buy',
        symbol: 'TKN',
        analysis_score: 75,
        risk_score: 30,
        ttl_hours: 24,
      });

      expect(mockQueryRawUnsafe).toHaveBeenCalledOnce();
      const sql: string = mockQueryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain("datetime('now', '+'");
      expect(sql).toContain('ON CONFLICT(address, chain)');
      expect(mockFindUnique).toHaveBeenCalledWith({
        where: { address_chain: { address: '0xtoken', chain: 'base' } },
      });
      expect(result.verdict).toBe('buy');
      expect(result.analysis_score).toBe(75);
      expect(result.expires_at).toBe('2099-01-01 00:00:00');
    });

    it('defaults ttl_hours to 24 when not provided', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      mockFindUnique.mockResolvedValue(makeRow());

      await repo.upsert({ address: '0xtoken', chain: 'base', verdict: 'avoid' });

      const args = mockQueryRawUnsafe.mock.calls[0] as unknown[];
      // ttl_hours arg is '24' (9th positional after the SQL template)
      expect(args[args.length - 1]).toBe('24');
    });

    it('throws NotFoundException if row not found after upsert', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      mockFindUnique.mockResolvedValue(null);

      await expect(repo.upsert({ address: '0xtoken', chain: 'base', verdict: 'buy' })).rejects.toThrow(
        'not found after upsert',
      );
    });
  });

  describe('findNonExpired', () => {
    it('queries with datetime comparison and maps rows', async () => {
      const row = makeRow();
      mockQueryRawUnsafe.mockResolvedValue([row]);

      const results = await repo.findNonExpired({ limit: 10 });

      const sql: string = mockQueryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain("expires_at > datetime('now')");
      expect(results).toHaveLength(1);
      expect(results[0]!.verdict).toBe('buy');
      expect(results[0]!.created_at).toBe('2026-05-14 10:00:00');
    });

    it('caps limit at 500', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      await repo.findNonExpired({ limit: 999 });
      const sql: string = mockQueryRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('LIMIT ?');
      // Second arg to $queryRawUnsafe is the limit value
      expect(mockQueryRawUnsafe.mock.calls[0][1]).toBe(500);
    });

    it('defaults limit to 50', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);
      await repo.findNonExpired({});
      expect(mockQueryRawUnsafe.mock.calls[0][1]).toBe(50);
    });
  });

  describe('findByAddressChain', () => {
    it('returns mapped entry when found', async () => {
      mockQueryRawUnsafe.mockResolvedValue([makeRow()]);

      const result = await repo.findByAddressChain({ address: '0xtoken', chain: 'base' });

      expect(result).not.toBeNull();
      expect(result!.address).toBe('0xtoken');
    });

    it('returns null when not found', async () => {
      mockQueryRawUnsafe.mockResolvedValue([]);

      const result = await repo.findByAddressChain({ address: '0xmissing', chain: 'base' });

      expect(result).toBeNull();
    });
  });

  describe('deleteExpiredBatch', () => {
    it('calls $executeRawUnsafe with DELETE statement and returns count', async () => {
      mockExecuteRawUnsafe.mockResolvedValue(3);

      const count = await repo.deleteExpiredBatch();

      expect(mockExecuteRawUnsafe).toHaveBeenCalledOnce();
      const sql: string = mockExecuteRawUnsafe.mock.calls[0][0] as string;
      expect(sql).toContain('DELETE FROM analysis_cache');
      expect(sql).toContain("expires_at <= datetime('now')");
      expect(count).toBe(3);
    });
  });
});
