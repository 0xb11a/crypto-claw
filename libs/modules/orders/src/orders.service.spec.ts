import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import type { OrdersRepository } from './orders.repository.js';
import type { OrderResponseDto } from './dto/order-response.dto.js';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@cclaw/config';
import type { Queue } from 'bullmq';
import type { ReceiptsService } from '@cclaw/receipts';
import { PaperExecutor } from './paper-executor.js';

const pendingOrder: OrderResponseDto = {
  id: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  amount: '100',
  status: 'pending',
};

const failedOrder: OrderResponseDto = { ...pendingOrder, status: 'failed' };
const approvedOrder: OrderResponseDto = { ...pendingOrder, status: 'approved', entry_price: 2000 };

function makeRepo(overrides?: Partial<OrdersRepository>): OrdersRepository {
  return {
    findMany: vi.fn().mockResolvedValue([pendingOrder]),
    count: vi.fn().mockResolvedValue(1),
    findById: vi.fn().mockResolvedValue(pendingOrder),
    create: vi.fn().mockResolvedValue(pendingOrder),
    transitionStatus: vi.fn().mockResolvedValue(approvedOrder),
    ...overrides,
  } as unknown as OrdersRepository;
}

function makeConfig(overrides: Partial<AppConfig> = {}): ConfigService {
  const cfg: Partial<AppConfig> = { AUTO_APPROVE_BUY: false, PAPER_MODE: false, ...overrides };
  // Use mockImplementation so that per-field get('KEY') calls return the individual value.
  // The service uses === true || === 'true' to normalise both boolean and string forms,
  // so returning the boolean directly here is correct.
  return {
    get: vi.fn().mockImplementation((key: string) => cfg[key as keyof typeof cfg]),
  } as unknown as ConfigService;
}

function makeQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'execute-order:order-1' }),
  } as unknown as Queue;
}

function makeReceiptsService(): ReceiptsService {
  return {
    create: vi.fn().mockResolvedValue({ id: 'receipt-1' }),
  } as unknown as ReceiptsService;
}

describe('OrdersService', () => {
  let svc: OrdersService;
  let repo: OrdersRepository;
  let queue: Queue;
  let receiptsService: ReceiptsService;
  let paperExecutor: PaperExecutor;

  function buildSvc(config?: ConfigService): OrdersService {
    return new OrdersService(repo, config ?? makeConfig(), queue, receiptsService, paperExecutor);
  }

  beforeEach(() => {
    repo = makeRepo();
    queue = makeQueue();
    receiptsService = makeReceiptsService();
    paperExecutor = new PaperExecutor();
    svc = buildSvc();
  });

  describe('list()', () => {
    it('returns paginated results', async () => {
      const result = await svc.list({ limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
    });
  });

  describe('propose()', () => {
    it('creates an order and returns it as pending', async () => {
      const result = await svc.propose({
        action: 'buy',
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        amount: '100',
      });
      expect(result.status).toBe('pending');
      expect(repo.transitionStatus).not.toHaveBeenCalled();
    });

    it('auto-approves BUY when AUTO_APPROVE_BUY is true', async () => {
      svc = buildSvc(makeConfig({ AUTO_APPROVE_BUY: true }));
      await svc.propose({ action: 'buy', symbol: 'ETH', address: '0xabc', chain: 'base', amount: '100' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'approved', 'auto', undefined, expect.any(Object));
    });

    it('does NOT auto-approve SELL orders even when flag is set', async () => {
      svc = buildSvc(makeConfig({ AUTO_APPROVE_BUY: true }));
      await svc.propose({ action: 'sell', symbol: 'ETH', address: '0xabc', chain: 'base', amount: '100' });
      expect(repo.transitionStatus).not.toHaveBeenCalled();
    });
  });

  describe('approve()', () => {
    it('transitions pending → approved', async () => {
      await svc.approve('order-1', { by: 'human' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'approved', 'human', undefined, expect.any(Object));
    });

    it('throws ConflictException for invalid transition', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await expect(svc.approve('order-1', {})).rejects.toThrow(ConflictException);
    });

    it('throws NotFoundException when order not found', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(svc.approve('bad-id', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('reject()', () => {
    it('transitions pending → rejected', async () => {
      await svc.reject('order-1', { reason: 'bad token' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'rejected', 'human', 'bad token');
    });

    it('throws ConflictException when rejecting an already-approved order', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await expect(svc.reject('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('cancel()', () => {
    it('transitions approved → cancelled', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await svc.cancel('order-1', { reason: 'operator cancelled' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'cancelled', 'human', 'operator cancelled');
    });

    it('throws ConflictException for pending → cancelled (not allowed)', async () => {
      await expect(svc.cancel('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('retry()', () => {
    it('transitions failed → approved', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(failedOrder);
      await svc.retry('order-1', { by: 'human' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'approved', 'human', 'retried', expect.any(Object));
    });

    it('throws ConflictException when retrying a non-failed order', async () => {
      await expect(svc.retry('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  // ---------------------------------------------------------------------------
  // execute() — P1c-i
  // ---------------------------------------------------------------------------
  describe('execute()', () => {
    it('throws ConflictException when order is not in approved status', async () => {
      // repo.findById returns pendingOrder (status: 'pending') by default
      await expect(svc.execute('order-1')).rejects.toThrow(ConflictException);
    });

    it('enqueues a BullMQ job in real mode (PAPER_MODE=false)', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      const result = await svc.execute('order-1');

      expect(result.status).toBe('enqueued');
      expect(result.orderId).toBe('order-1');
      expect(result.jobId).toBe('execute-order-order-1');
      expect(queue.add).toHaveBeenCalledWith(
        'execute-order',
        { orderId: 'order-1' },
        expect.objectContaining({ jobId: 'execute-order-order-1' }),
      );
    });

    it('transitions order to executing in real mode before enqueue', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await svc.execute('order-1');
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'executing', 'orders-service');
    });

    it('short-circuits in paper mode without enqueueing', async () => {
      svc = buildSvc(makeConfig({ PAPER_MODE: true }));
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      const result = await svc.execute('order-1');

      expect(result.status).toBe('paper_executed');
      expect(result.jobId).toBeNull();
      expect(queue.add).not.toHaveBeenCalled();
    });

    it('creates paper receipt in paper mode', async () => {
      svc = buildSvc(makeConfig({ PAPER_MODE: true }));
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await svc.execute('order-1');

      expect(receiptsService.create).toHaveBeenCalledWith(
        expect.objectContaining({
          order_id: 'order-1',
          mode: 'paper',
        }),
      );
    });

    it('transitions to executed after paper simulation', async () => {
      svc = buildSvc(makeConfig({ PAPER_MODE: true }));
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      await svc.execute('order-1');

      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'executed', 'orders-service');
    });

    it('uses deterministic jobId for idempotency', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(approvedOrder);
      const result1 = await svc.execute('order-1');
      const result2 = await svc.execute('order-1');
      // Both calls produce the same jobId
      expect(result1.jobId).toBe(result2.jobId);
    });
  });
});
