import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
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

    it('passes pending filter as status IN (pending, approved) — legacy semantics', async () => {
      // Legacy db-query.js: status IN ('pending', 'approved') = "awaiting execution"
      // (SPEC §19 #2 byte-identical contract / db-query.js line 605)
      await repo.findMany({ pending: true });
      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: { in: ['pending', 'approved'] } }),
        }),
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

  // ---------------------------------------------------------------------------
  // transitionApproval() — P3g3 PR-F (ADR-0027)
  // ---------------------------------------------------------------------------

  describe('transitionApproval()', () => {
    const approvedRow = {
      ...rawOrder,
      status: 'approved',
      approvedAt: '2026-05-15T00:00:00.000Z',
      approvedBy: 'telegram',
      statusChangedAt: '2026-05-15T00:00:00.000Z',
      statusChangedBy: 'telegram',
    };

    it('returns { updated: true, order } when status matches fromStatus', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      const result = await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      expect(result.updated).toBe(true);
      expect(result.order).toBeDefined();
      expect(result.order!.status).toBe('approved');
    });

    it('passes compound where clause { id, status: fromStatus } to prisma.order.update', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'order-1', status: 'pending' },
        }),
      );
    });

    it('sets status, statusChangedAt, statusChangedBy, updatedAt in data', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      const call = (prisma.order.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe('approved');
      expect(call.data.statusChangedBy).toBe('telegram');
      expect(typeof call.data.statusChangedAt).toBe('string');
      expect(typeof call.data.updatedAt).toBe('string');
    });

    it('sets approvedAt and approvedBy when toStatus is "approved"', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      const call = (prisma.order.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(typeof call.data.approvedAt).toBe('string');
      expect(call.data.approvedBy).toBe('telegram');
    });

    it('does NOT set approvedAt/approvedBy when toStatus is "rejected"', async () => {
      const rejectedRow = { ...rawOrder, status: 'rejected' };
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(rejectedRow);

      await repo.transitionApproval('order-1', 'pending', 'rejected', 'telegram');

      const call = (prisma.order.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.approvedAt).toBeUndefined();
      expect(call.data.approvedBy).toBeUndefined();
    });

    it('returns { updated: false } on P2025 (status mismatch — optimistic-lock race)', async () => {
      const p2025 = new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: '5.x',
      });
      (prisma.order.update as ReturnType<typeof vi.fn>).mockRejectedValue(p2025);

      const result = await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      expect(result.updated).toBe(false);
      expect(result.order).toBeUndefined();
    });

    it('propagates non-P2025 Prisma errors', async () => {
      const unexpected = new Prisma.PrismaClientKnownRequestError('Connection reset', {
        code: 'P2002',
        clientVersion: '5.x',
      });
      (prisma.order.update as ReturnType<typeof vi.fn>).mockRejectedValue(unexpected);

      await expect(repo.transitionApproval('order-1', 'pending', 'approved', 'telegram')).rejects.toThrow(
        Prisma.PrismaClientKnownRequestError,
      );
    });

    it('propagates generic errors (not PrismaClientKnownRequestError)', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('GENERIC_DB_ERROR'));

      await expect(repo.transitionApproval('order-1', 'pending', 'approved', 'telegram')).rejects.toThrow(
        'GENERIC_DB_ERROR',
      );
    });

    it('approvedBy is correctly written in order response on approve', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      const result = await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      expect(result.order!.approved_by).toBe('telegram');
    });

    it('returned order has status=approved after successful approve transition', async () => {
      (prisma.order.update as ReturnType<typeof vi.fn>).mockResolvedValue(approvedRow);

      const result = await repo.transitionApproval('order-1', 'pending', 'approved', 'telegram');

      expect(result.order!.status).toBe('approved');
    });
  });
});
