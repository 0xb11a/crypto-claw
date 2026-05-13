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

  // ---------------------------------------------------------------------------
  // Adversarial: liquidity boundary values (coder-flagged check 5)
  // ---------------------------------------------------------------------------

  describe('create() boundary values for liquidity_usd', () => {
    it('accepts liquidity_usd=0 (valid edge case for rugged pool)', async () => {
      // The repository layer must not reject zero — DTO validation is the gatekeeping layer.
      // This verifies that the repository passes through 0 to Prisma without modification.
      const result = await repo.create({ address: '0xrugged', chain: 'base', liquidity_usd: 0 });
      expect(result.ok).toBe(true);
      const call = (prisma.liquiditySnapshot.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.liquidityUsd).toBe(0);
    });

    it('passes through negative liquidity_usd to Prisma (DTO layer is responsible for rejection)', async () => {
      // The repository is not responsible for sign validation — @IsNumber() in the DTO
      // catches this before the repository is ever called. This test documents the boundary.
      const result = await repo.create({ address: '0xpool', chain: 'base', liquidity_usd: -100 });
      expect(result.ok).toBe(true);
      const call = (prisma.liquiditySnapshot.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.liquidityUsd).toBe(-100);
    });

    it('accepts large liquidity_usd values', async () => {
      const result = await repo.create({ address: '0xpool', chain: 'base', liquidity_usd: 1_000_000_000 });
      expect(result.ok).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Coverage: mapRow with null checkedAt (liquidity.repository.ts line 22)
  // ---------------------------------------------------------------------------

  describe('mapRow with nullable fields', () => {
    it('returns checked_at as null when checkedAt is null', async () => {
      const rowWithNullDate = { ...rawRow, checkedAt: null };
      const p = {
        liquiditySnapshot: {
          findMany: vi.fn().mockResolvedValue([rowWithNullDate]),
          create: vi.fn().mockResolvedValue(rowWithNullDate),
        },
      } as unknown as PrismaService;
      const r = new LiquidityRepository(p);
      const result = await r.findMany({});
      expect(result[0]!.checked_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Coverage: findMany capping limit at 100
  // ---------------------------------------------------------------------------

  describe('findMany() limit capping', () => {
    it('caps limit at 100 when a value > 100 is provided', async () => {
      await repo.findMany({ limit: 200 });
      const call = (prisma.liquiditySnapshot.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        take: number;
      };
      expect(call.take).toBe(100);
    });

    it('respects limit when <= 100', async () => {
      await repo.findMany({ limit: 10 });
      const call = (prisma.liquiditySnapshot.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        take: number;
      };
      expect(call.take).toBe(10);
    });
  });
});
