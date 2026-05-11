/**
 * Unit tests for ReceiptsService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ReceiptsService } from './receipts.service.js';
import type { ReceiptsRepository } from './receipts.repository.js';
import type { ReceiptResponseDto } from './dto/receipt-response.dto.js';

const receipt: ReceiptResponseDto = {
  id: 'receipt-1',
  order_id: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  status: 'executed',
  mode: 'real',
};

function makeRepo(overrides?: Partial<ReceiptsRepository>): ReceiptsRepository {
  return {
    findMany: vi.fn().mockResolvedValue([receipt]),
    findById: vi.fn().mockResolvedValue(receipt),
    create: vi.fn().mockResolvedValue(receipt),
    count: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as ReceiptsRepository;
}

describe('ReceiptsService', () => {
  let svc: ReceiptsService;
  let repo: ReceiptsRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new ReceiptsService(repo);
  });

  describe('list()', () => {
    it('returns paginated envelope with data and pagination', async () => {
      const result = await svc.list({ limit: 50 });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasMore).toBe(false);
      expect(result.pagination.cursor).toBe('receipt-1');
    });

    it('clamps limit to 200', async () => {
      await svc.list({ limit: 999 });
      // findMany is called with the original query — the service sets limit to 200 internally
      // Verify that the pagination limit reflects capped value
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue([receipt]), count: vi.fn().mockResolvedValue(1) });
      const s = new ReceiptsService(r);
      const res = await s.list({ limit: 999 });
      expect(res.pagination.limit).toBe(200);
    });

    it('hasMore=true when data.length === limit', async () => {
      const manyReceipts = Array.from({ length: 50 }, (_, i) => ({ ...receipt, id: `r-${i}` }));
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue(manyReceipts), count: vi.fn().mockResolvedValue(100) });
      const s = new ReceiptsService(r);
      const res = await s.list({ limit: 50 });
      expect(res.pagination.hasMore).toBe(true);
    });

    it('cursor is undefined when data is empty', async () => {
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue([]), count: vi.fn().mockResolvedValue(0) });
      const s = new ReceiptsService(r);
      const res = await s.list({});
      expect(res.pagination.cursor).toBeUndefined();
    });
  });

  describe('getById()', () => {
    it('returns receipt by ID', async () => {
      const result = await svc.getById('receipt-1');
      expect(repo.findById).toHaveBeenCalledWith('receipt-1', 'real');
      expect(result).toBe(receipt);
    });

    it('propagates NotFoundException from repository', async () => {
      const r = makeRepo({ findById: vi.fn().mockRejectedValue(new NotFoundException('Receipt receipt-x not found')) });
      const s = new ReceiptsService(r);
      await expect(s.getById('receipt-x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to repository and returns new receipt', async () => {
      const dto = {
        order_id: 'order-1',
        action: 'buy' as const,
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        status: 'executed',
      };
      const result = await svc.create(dto);
      expect(repo.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(receipt);
    });
  });
});
