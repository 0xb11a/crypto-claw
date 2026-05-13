/**
 * Unit tests for ReceiptsController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReceiptsController } from './receipts.controller.js';
import type { ReceiptsService } from './receipts.service.js';
import type { ReceiptResponseDto, ReceiptListResponseDto } from './dto/receipt-response.dto.js';

const realReceipt: ReceiptResponseDto = {
  id: 'receipt-1',
  order_id: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  status: 'executed',
  mode: 'real',
};

const paperReceipt: ReceiptResponseDto = {
  id: 'paper-receipt-1',
  order_id: 'order-2',
  action: 'buy',
  symbol: 'SOL',
  address: 'So111',
  chain: 'solana',
  status: 'executed',
  proposed_price: 100,
  mode: 'paper',
};

const listResponse: ReceiptListResponseDto = {
  data: [realReceipt],
  pagination: { total: 1, limit: 50, cursor: 'receipt-1', hasMore: false },
};

function makeService(overrides?: Partial<ReceiptsService>): ReceiptsService {
  return {
    list: vi.fn().mockResolvedValue(listResponse),
    getById: vi.fn().mockResolvedValue(realReceipt),
    create: vi.fn().mockResolvedValue(realReceipt),
    ...overrides,
  } as unknown as ReceiptsService;
}

describe('ReceiptsController', () => {
  let ctrl: ReceiptsController;
  let svc: ReceiptsService;

  beforeEach(() => {
    svc = makeService();
    ctrl = new ReceiptsController(svc);
  });

  describe('list()', () => {
    it('delegates query to service and returns result', async () => {
      const result = await ctrl.list({ limit: 10 });
      expect(svc.list).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toBe(listResponse);
    });

    it('passes mode=paper filter to service', async () => {
      await ctrl.list({ mode: 'paper' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paper' }));
    });

    it('passes status filter to service', async () => {
      await ctrl.list({ status: 'executed' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'executed' }));
    });
  });

  describe('getById()', () => {
    it('returns real receipt by default', async () => {
      const result = await ctrl.getById('receipt-1', undefined);
      expect(svc.getById).toHaveBeenCalledWith('receipt-1', 'real');
      expect(result).toBe(realReceipt);
    });

    it('passes mode=paper to service', async () => {
      const paperSvc = makeService({ getById: vi.fn().mockResolvedValue(paperReceipt) });
      const paperCtrl = new ReceiptsController(paperSvc);
      const result = await paperCtrl.getById('paper-receipt-1', 'paper');
      expect(paperSvc.getById).toHaveBeenCalledWith('paper-receipt-1', 'paper');
      expect(result).toBe(paperReceipt);
    });
  });

  describe('create()', () => {
    it('delegates to service.create and returns created receipt', async () => {
      const dto = {
        order_id: 'order-1',
        action: 'buy' as const,
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        status: 'executed',
      };
      const result = await ctrl.create(dto);
      expect(svc.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(realReceipt);
    });
  });
});
