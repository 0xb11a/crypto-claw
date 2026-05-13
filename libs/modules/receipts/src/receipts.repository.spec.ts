/**
 * Unit tests for ReceiptsRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ReceiptsRepository } from './receipts.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawReceipt = {
  id: 'receipt-1',
  orderId: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  status: 'executed',
  amount: 100.0,
  quantity: 0.05,
  expectedPrice: 2000.0,
  executedPrice: 2005.0,
  slippage: 0.0025,
  safeTxHash: '0xsafe',
  onchainTxHash: '0xonchain',
  safeNonce: 42,
  signaturesCollected: 2,
  signaturesRequired: 2,
  gasUsed: '21000',
  error: null,
  notes: null,
  positionId: 'pos-1',
  createdAt: '2026-01-01T00:00:00Z',
};

const rawPaperReceipt = {
  id: 'paper-1',
  orderId: 'order-2',
  action: 'sell',
  symbol: 'SOL',
  address: 'So111',
  chain: 'solana',
  tier: 'moonshot',
  proposedPrice: 100.0,
  quantity: 2.0,
  amount: 200.0,
  stopLoss: 80.0,
  takeProfitLevels: '[120,140]',
  reasoning: 'good exit',
  pnlPercent: 20.0,
  pnlUsd: 40.0,
  createdAt: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  return {
    receipt: {
      findMany: vi.fn().mockResolvedValue([rawReceipt]),
      findUnique: vi.fn().mockResolvedValue(rawReceipt),
      create: vi.fn().mockResolvedValue(rawReceipt),
      count: vi.fn().mockResolvedValue(1),
    },
    paperReceipt: {
      findMany: vi.fn().mockResolvedValue([rawPaperReceipt]),
      findUnique: vi.fn().mockResolvedValue(rawPaperReceipt),
      create: vi.fn().mockResolvedValue(rawPaperReceipt),
      count: vi.fn().mockResolvedValue(1),
    },
  } as unknown as PrismaService;
}

describe('ReceiptsRepository', () => {
  let repo: ReceiptsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new ReceiptsRepository(prisma);
  });

  describe('findMany() — real mode', () => {
    it('returns mapped receipts with snake_case fields', async () => {
      const receipts = await repo.findMany({});
      expect(receipts).toHaveLength(1);
      const r = receipts[0]!;
      expect(r.id).toBe('receipt-1');
      expect(r.order_id).toBe('order-1');
      expect(r.executed_price).toBe(2005.0);
      expect(r.safe_nonce).toBe(42);
      expect(r.mode).toBe('real');
    });

    it('passes status filter to Prisma', async () => {
      await repo.findMany({ status: 'executed' });
      expect(prisma.receipt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ status: 'executed' }) }),
      );
    });
  });

  describe('findMany() — paper mode', () => {
    it('routes to paperReceipt table and returns mapped rows', async () => {
      const receipts = await repo.findMany({ mode: 'paper' });
      expect(prisma.paperReceipt.findMany).toHaveBeenCalled();
      expect(receipts[0]!.mode).toBe('paper');
      expect(receipts[0]!.proposed_price).toBe(100.0);
    });
  });

  describe('findById()', () => {
    it('returns mapped real receipt', async () => {
      const result = await repo.findById('receipt-1');
      expect(result.id).toBe('receipt-1');
      expect(result.mode).toBe('real');
    });

    it('throws NotFoundException for missing real receipt', async () => {
      (prisma.receipt.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('missing')).rejects.toThrow(NotFoundException);
    });

    it('returns mapped paper receipt', async () => {
      const result = await repo.findById('paper-1', 'paper');
      expect(result.mode).toBe('paper');
      expect(result.pnl_percent).toBe(20.0);
    });

    it('throws NotFoundException for missing paper receipt', async () => {
      (prisma.paperReceipt.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('missing', 'paper')).rejects.toThrow(NotFoundException);
    });
  });

  describe('count()', () => {
    it('counts real receipts', async () => {
      const count = await repo.count({});
      expect(count).toBe(1);
      expect(prisma.receipt.count).toHaveBeenCalled();
    });

    it('counts paper receipts', async () => {
      const count = await repo.count({ mode: 'paper' });
      expect(count).toBe(1);
      expect(prisma.paperReceipt.count).toHaveBeenCalled();
    });
  });

  describe('create() — real mode', () => {
    it('creates a real receipt and returns mapped row', async () => {
      const dto = {
        order_id: 'order-1',
        action: 'buy' as const,
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        status: 'executed',
        amount: 100.0,
        quantity: 0.05,
        expected_price: 2000.0,
        executed_price: 2005.0,
      };
      const result = await repo.create(dto);
      expect(result.id).toBe('receipt-1');
      expect(result.mode).toBe('real');
      expect(prisma.receipt.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'buy',
            symbol: 'ETH',
            chain: 'base',
          }),
        }),
      );
    });
  });

  describe('create() — paper mode', () => {
    it('creates a paper receipt when mode=paper and expected_price is set', async () => {
      const dto = {
        order_id: 'order-2',
        action: 'sell' as const,
        symbol: 'SOL',
        address: 'So111',
        chain: 'solana',
        status: 'executed',
        mode: 'paper' as const,
        expected_price: 100.0,
        quantity: 2.0,
        amount: 200.0,
      };
      const result = await repo.create(dto);
      expect(result.mode).toBe('paper');
      expect(prisma.paperReceipt.create).toHaveBeenCalled();
    });

    it('throws when mode=paper and expected_price is missing', async () => {
      const dto = {
        order_id: 'order-2',
        action: 'sell' as const,
        symbol: 'SOL',
        address: 'So111',
        chain: 'solana',
        status: 'executed',
        mode: 'paper' as const,
        // expected_price intentionally omitted
      };
      await expect(repo.create(dto)).rejects.toThrow('paper receipts require expected_price as proposed_price');
    });
  });
});
