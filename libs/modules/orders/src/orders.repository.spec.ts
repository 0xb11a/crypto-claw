import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { OrdersRepository } from './orders.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawOrder = {
  id: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  name: null,
  address: '0xabc',
  chain: 'base',
  amount: '100',
  percentOfPortfolio: 5,
  tier: 'conviction',
  entryPrice: 2000,
  stopLoss: 1600,
  takeProfitLevels: '[2500,3000]',
  analysisScore: 80,
  riskScore: 20,
  reasoning: 'good token',
  reason: null,
  urgency: null,
  approvedAt: null,
  approvedBy: null,
  status: 'pending',
  statusReason: null,
  statusChangedAt: null,
  statusChangedBy: null,
  updatedAt: '2026-01-01T00:00:00Z',
  tgMessageId: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  return {
    order: {
      findMany: vi.fn().mockResolvedValue([rawOrder]),
      findUnique: vi.fn().mockResolvedValue(rawOrder),
      create: vi.fn().mockResolvedValue(rawOrder),
      update: vi.fn().mockResolvedValue(rawOrder),
      count: vi.fn().mockResolvedValue(1),
    },
  } as unknown as PrismaService;
}

describe('OrdersRepository', () => {
  let repo: OrdersRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new OrdersRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns mapped orders with parsed take_profit_levels', async () => {
      const orders = await repo.findMany({});
      expect(orders).toHaveLength(1);
      expect(orders[0]!.take_profit_levels).toEqual([2500, 3000]);
      expect(orders[0]!.status).toBe('pending');
    });

    it('passes pending filter', async () => {
      await repo.findMany({ pending: true });
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'pending' }) }),
      );
    });
  });

  describe('findById()', () => {
    it('returns a mapped order', async () => {
      const order = await repo.findById('order-1');
      expect(order.id).toBe('order-1');
      expect(order.take_profit_levels).toEqual([2500, 3000]);
    });

    it('throws NotFoundException when order not found', async () => {
      (prisma.order.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('creates an order and returns mapped result', async () => {
      const result = await repo.create({
        action: 'buy',
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        amount: '100',
        take_profit_levels: [2500, 3000],
      });
      expect(result.id).toBe('order-1');
    });

    it('serialises take_profit_levels to JSON string in the DB write', async () => {
      await repo.create({
        action: 'buy',
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        amount: '100',
        take_profit_levels: [5, 10, 20],
      });
      const call = (prisma.order.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: { takeProfitLevels: string };
      };
      expect(call.data.takeProfitLevels).toBe('[5,10,20]');
    });
  });

  describe('transitionStatus()', () => {
    it('calls prisma.order.update with correct fields', async () => {
      await repo.transitionStatus('order-1', 'approved', 'human', 'ok', {
        approvedAt: '2026-01-01T00:00:00Z',
        approvedBy: 'human',
      });
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1' },
          data: expect.objectContaining({
            status: 'approved',
            statusChangedBy: 'human',
          }),
        }),
      );
    });
  });

  describe('JSON field handling', () => {
    it('returns null for null take_profit_levels', async () => {
      const nullRow = { ...rawOrder, takeProfitLevels: null };
      (prisma.order.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(nullRow);
      const order = await repo.findById('order-1');
      expect(order.take_profit_levels).toBeNull();
    });

    it('returns null for malformed JSON in take_profit_levels', async () => {
      const badRow = { ...rawOrder, takeProfitLevels: 'not-json' };
      (prisma.order.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(badRow);
      const order = await repo.findById('order-1');
      expect(order.take_profit_levels).toBeNull();
    });
  });
});
