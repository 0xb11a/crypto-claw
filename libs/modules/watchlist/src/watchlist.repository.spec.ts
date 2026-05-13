/**
 * Unit tests for WatchlistRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WatchlistRepository } from './watchlist.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawRow = {
  id: 'watch-1',
  symbol: 'ETH',
  address: '0xtoken',
  chain: 'base',
  targetEntry: 2000.0,
  currentPrice: 2100.0,
  analysisScore: 80,
  riskScore: 20,
  narrative: 'ETH narrative',
  reason: 'Strong fundamentals',
  expiresAt: null,
  status: 'watching',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makePrisma(overrides?: Record<string, unknown>): PrismaService {
  return {
    watchlist: {
      findMany: vi.fn().mockResolvedValue([rawRow]),
      findUnique: vi.fn().mockResolvedValue(rawRow),
      create: vi.fn().mockResolvedValue(rawRow),
      update: vi.fn().mockResolvedValue({ ...rawRow, status: 'removed' }),
    },
    ...overrides,
  } as unknown as PrismaService;
}

describe('WatchlistRepository', () => {
  let repo: WatchlistRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new WatchlistRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns all rows when status is not specified', async () => {
      const result = await repo.findMany({});
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: unknown;
      };
      expect(call.where).toBeUndefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('filters by status when status="watching"', async () => {
      await repo.findMany({ status: 'watching' });
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ status: 'watching' });
    });

    it('returns all rows when status="all"', async () => {
      await repo.findMany({ status: 'all' });
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: unknown;
      };
      expect(call.where).toBeUndefined();
    });

    it('maps camelCase to snake_case in response', async () => {
      const result = await repo.findMany({});
      const r = result[0]!;
      expect(r.analysis_score).toBe(80);
      expect(r.target_entry).toBe(2000.0);
    });
  });

  describe('findById()', () => {
    it('returns the mapped watchlist entry', async () => {
      const result = await repo.findById('watch-1');
      expect(result.id).toBe('watch-1');
      expect(result.symbol).toBe('ETH');
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: { findUnique: vi.fn().mockResolvedValue(null) },
      });
      const r = new WatchlistRepository(p);
      await expect(r.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('inserts the entry and returns the mapped row', async () => {
      const dto = {
        id: 'watch-1',
        symbol: 'ETH',
        address: '0xtoken',
        chain: 'base',
      };
      const result = await repo.create(dto);
      expect(result.id).toBe('watch-1');
      const call = (prisma.watchlist.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe('watching');
    });
  });

  describe('update()', () => {
    it('updates fields and returns the mapped row', async () => {
      const result = await repo.update('watch-1', { current_price: 2200 });
      expect(result).toBeDefined();
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WatchlistRepository(p);
      await expect(r.update('missing', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDelete()', () => {
    it('sets status=removed and returns ok=true', async () => {
      const result = await repo.softDelete('watch-1');
      expect(result.ok).toBe(true);
      expect(result.id).toBe('watch-1');
      const call = (prisma.watchlist.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe('removed');
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WatchlistRepository(p);
      await expect(r.softDelete('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
