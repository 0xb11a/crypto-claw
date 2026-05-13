/**
 * Unit tests for LiquidityRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LiquidityRepository } from './liquidity.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawRow = {
  id: 1,
  address: '0xpool',
  chain: 'base',
  liquidityUsd: 50000.0,
  checkedAt: '2026-01-01T00:00:00.000Z',
};

function makePrisma(): PrismaService {
  return {
    liquiditySnapshot: {
      findMany: vi.fn().mockResolvedValue([rawRow]),
      create: vi.fn().mockResolvedValue(rawRow),
    },
  } as unknown as PrismaService;
}

describe('LiquidityRepository', () => {
  let repo: LiquidityRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new LiquidityRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns mapped rows with snake_case fields', async () => {
      const result = await repo.findMany({});
      expect(Array.isArray(result)).toBe(true);
      const r = result[0]!;
      expect(r.id).toBe(1);
      expect(r.address).toBe('0xpool');
      expect(r.chain).toBe('base');
      expect(r.liquidity_usd).toBe(50000.0);
      expect(r.checked_at).toBe('2026-01-01T00:00:00.000Z');
    });

    it('defaults limit to 2 per legacy semantics', async () => {
      await repo.findMany({});
      const call = (prisma.liquiditySnapshot.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        take: number;
      };
      expect(call.take).toBe(2);
    });

    it('passes address/chain filters when provided', async () => {
      await repo.findMany({ address: '0xpool', chain: 'base' });
      const call = (prisma.liquiditySnapshot.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ address: '0xpool', chain: 'base' });
    });

    it('orders by checked_at DESC', async () => {
      await repo.findMany({});
      const call = (prisma.liquiditySnapshot.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        orderBy: Record<string, unknown>;
      };
      expect(call.orderBy).toEqual({ checkedAt: 'desc' });
    });
  });

  describe('create()', () => {
    it('inserts a snapshot and returns ok=true', async () => {
      const result = await repo.create({ address: '0xpool', chain: 'base', liquidity_usd: 50000 });
      expect(result.ok).toBe(true);
      const call = (prisma.liquiditySnapshot.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.address).toBe('0xpool');
      expect(call.data.liquidityUsd).toBe(50000);
    });
  });
});
