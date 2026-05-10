import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PositionsRepository } from './positions.repository.js';
import type { PrismaService } from '@cclaw/prisma';

// Minimal stub for a Position row
const rawPosition = {
  id: 'pos-1',
  symbol: 'ETH',
  name: null,
  address: '0xabc',
  chain: 'base',
  tier: 'conviction',
  entryPrice: 2000,
  currentPrice: 2100,
  quantity: 0.5,
  valueUsd: 1050,
  percentOfPortfolio: 5,
  entryDate: '2026-01-01',
  stopLoss: 1600,
  takeProfitLevels: '[2500,3000,4000]',
  narrative: 'defi',
  status: 'open',
  notes: null,
  onchainBalance: null,
  lastSyncedAt: null,
  exitPrice: null,
  exitDate: null,
  pnlPercent: null,
  pnlUsd: null,
  exitReason: null,
  maxPriceSinceEntry: null,
  trailingStopPct: null,
  trailingStopActive: 0,
  tpLevelsHit: '[]',
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

const makePrisma = (): PrismaService =>
  ({
    position: {
      findMany: vi.fn().mockResolvedValue([rawPosition]),
      findUnique: vi.fn().mockResolvedValue(rawPosition),
      create: vi.fn().mockResolvedValue(rawPosition),
      update: vi.fn().mockResolvedValue(rawPosition),
      delete: vi.fn().mockResolvedValue(undefined),
      count: vi.fn().mockResolvedValue(1),
    },
    paperPosition: {
      findMany: vi.fn().mockResolvedValue([]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn().mockResolvedValue(0),
    },
  }) as unknown as PrismaService;

describe('PositionsRepository', () => {
  let repo: PositionsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new PositionsRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns mapped positions with parsed JSON arrays', async () => {
      const rows = await repo.findMany({});
      expect(rows).toHaveLength(1);
      expect(rows[0]!.take_profit_levels).toEqual([2500, 3000, 4000]);
      expect(rows[0]!.tp_levels_hit).toEqual([]);
      expect(rows[0]!.mode).toBe('real');
    });

    it('queries paper_positions for mode=paper', async () => {
      await repo.findMany({ mode: 'paper' });
      expect(prisma.paperPosition.findMany).toHaveBeenCalled();
      expect(prisma.position.findMany).not.toHaveBeenCalled();
    });
  });

  describe('findById()', () => {
    it('returns a mapped position', async () => {
      const pos = await repo.findById('pos-1', 'real');
      expect(pos.id).toBe('pos-1');
      expect(pos.take_profit_levels).toEqual([2500, 3000, 4000]);
    });

    it('throws NotFoundException when position not found', async () => {
      (prisma.position.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('bad-id', 'real')).rejects.toThrow(NotFoundException);
    });

    it('throws NotFoundException for missing paper position', async () => {
      await expect(repo.findById('bad-id', 'paper')).rejects.toThrow(NotFoundException);
    });
  });

  describe('JSON field handling', () => {
    it('parses malformed JSON gracefully as empty array', async () => {
      const badRow = { ...rawPosition, takeProfitLevels: 'not-json', tpLevelsHit: '{{}' };
      (prisma.position.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(badRow);
      const pos = await repo.findById('pos-1', 'real');
      expect(pos.take_profit_levels).toEqual([]);
      expect(pos.tp_levels_hit).toEqual([]);
    });

    it('parses null JSON column as empty array', async () => {
      const nullRow = { ...rawPosition, takeProfitLevels: null, tpLevelsHit: null };
      (prisma.position.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(nullRow);
      const pos = await repo.findById('pos-1', 'real');
      expect(pos.take_profit_levels).toEqual([]);
    });
  });
});
