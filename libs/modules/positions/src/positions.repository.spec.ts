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
      findMany: vi.fn().mockResolvedValue([rawPosition]),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(rawPosition),
      update: vi.fn().mockResolvedValue(rawPosition),
      delete: vi.fn().mockResolvedValue(undefined),
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

  describe('create()', () => {
    it('creates a real position and returns mapped result', async () => {
      (prisma.position.create as ReturnType<typeof vi.fn>).mockResolvedValue(rawPosition);
      const result = await repo.create({
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        tier: 'conviction',
        entry_price: 2000,
        quantity: 0.5,
        stop_loss: 1600,
        take_profit_levels: [2500, 3000, 4000],
      });
      expect(result.symbol).toBe('ETH');
      expect(result.take_profit_levels).toEqual([2500, 3000, 4000]);
      expect(result.mode).toBe('real');
    });

    it('creates a paper position when mode=paper', async () => {
      const paperRaw = { ...rawPosition };
      (prisma.paperPosition.create as ReturnType<typeof vi.fn>).mockResolvedValue(paperRaw);
      const result = await repo.create({
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        tier: 'conviction',
        entry_price: 2000,
        quantity: 0.5,
        stop_loss: 1600,
        take_profit_levels: [2500, 3000],
        mode: 'paper',
      });
      expect(prisma.paperPosition.create).toHaveBeenCalled();
      expect(result.mode).toBe('paper');
    });

    it('serialises take_profit_levels to JSON string in DB write', async () => {
      (prisma.position.create as ReturnType<typeof vi.fn>).mockResolvedValue(rawPosition);
      await repo.create({
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        tier: 'conviction',
        entry_price: 2000,
        quantity: 0.5,
        stop_loss: 1600,
        take_profit_levels: [5, 10, 20],
      });
      const call = (prisma.position.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: { takeProfitLevels: string };
      };
      expect(call.data.takeProfitLevels).toBe('[5,10,20]');
    });
  });

  describe('update()', () => {
    it('updates a real position', async () => {
      (prisma.position.update as ReturnType<typeof vi.fn>).mockResolvedValue(rawPosition);
      const result = await repo.update('pos-1', { stop_loss: 1500 }, 'real');
      expect(prisma.position.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'pos-1' } }));
      expect(result.id).toBe('pos-1');
    });

    it('updates a paper position when mode=paper', async () => {
      (prisma.paperPosition.update as ReturnType<typeof vi.fn>).mockResolvedValue(rawPosition);
      await repo.update('pos-1', { stop_loss: 1500 }, 'paper');
      expect(prisma.paperPosition.update).toHaveBeenCalled();
      expect(prisma.position.update).not.toHaveBeenCalled();
    });
  });

  describe('closePosition()', () => {
    it('closes a real position', async () => {
      const closedRaw = { ...rawPosition, status: 'closed', exitPrice: 2500 };
      (prisma.position.update as ReturnType<typeof vi.fn>).mockResolvedValue(closedRaw);
      const result = await repo.closePosition('pos-1', { exit_price: 2500 }, 'real');
      expect(result.status).toBe('closed');
    });

    it('closes a paper position', async () => {
      const closedRaw = { ...rawPosition, status: 'closed', exitPrice: 2500 };
      (prisma.paperPosition.update as ReturnType<typeof vi.fn>).mockResolvedValue(closedRaw);
      await repo.closePosition('pos-1', { exit_price: 2500 }, 'paper');
      expect(prisma.paperPosition.update).toHaveBeenCalled();
    });
  });

  describe('delete()', () => {
    it('deletes a real position', async () => {
      await repo.delete('pos-1', 'real');
      expect(prisma.position.delete).toHaveBeenCalledWith({ where: { id: 'pos-1' } });
    });

    it('deletes a paper position', async () => {
      await repo.delete('pos-1', 'paper');
      expect(prisma.paperPosition.delete).toHaveBeenCalledWith({ where: { id: 'pos-1' } });
      expect(prisma.position.delete).not.toHaveBeenCalled();
    });
  });

  describe('count()', () => {
    it('counts real positions', async () => {
      (prisma.position.count as ReturnType<typeof vi.fn>).mockResolvedValue(5);
      const result = await repo.count({ status: 'open' });
      expect(result).toBe(5);
      expect(prisma.position.count).toHaveBeenCalled();
    });

    it('counts paper positions for mode=paper', async () => {
      (prisma.paperPosition.count as ReturnType<typeof vi.fn>).mockResolvedValue(3);
      const result = await repo.count({ mode: 'paper' });
      expect(result).toBe(3);
      expect(prisma.paperPosition.count).toHaveBeenCalled();
      expect(prisma.position.count).not.toHaveBeenCalled();
    });

    it('applies status and chain filters for real positions', async () => {
      (prisma.position.count as ReturnType<typeof vi.fn>).mockResolvedValue(2);
      await repo.count({ status: 'open', chain: 'base' });
      expect(prisma.position.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'open', chain: 'base' }) }),
      );
    });

    it('applies symbol filter via contains', async () => {
      (prisma.position.count as ReturnType<typeof vi.fn>).mockResolvedValue(1);
      await repo.count({ symbol: 'ETH' });
      expect(prisma.position.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ symbol: { contains: 'ETH' } }) }),
      );
    });
  });

  describe('findMany() filter branches', () => {
    it('applies status filter', async () => {
      await repo.findMany({ status: 'open' });
      expect(prisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'open' }) }),
      );
    });

    it('applies chain filter', async () => {
      await repo.findMany({ chain: 'base' });
      expect(prisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ chain: 'base' }) }),
      );
    });

    it('applies symbol filter via contains', async () => {
      await repo.findMany({ symbol: 'ETH' });
      expect(prisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ symbol: { contains: 'ETH' } }) }),
      );
    });

    it('applies cursor filter', async () => {
      await repo.findMany({ cursor: 'pos-0' });
      expect(prisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { gt: 'pos-0' } }) }),
      );
    });
  });
});
