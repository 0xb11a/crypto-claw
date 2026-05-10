import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { OrdersService } from './orders.service.js';
import type { OrdersRepository } from './orders.repository.js';
import type { OrderResponseDto } from './dto/order-response.dto.js';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@cclaw/config';

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
const approvedOrder: OrderResponseDto = { ...pendingOrder, status: 'approved' };

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

function makeConfig(autoApproveBuy = false): ConfigService {
  const cfg: Partial<AppConfig> = { AUTO_APPROVE_BUY: autoApproveBuy };
  return { get: vi.fn().mockReturnValue(cfg) } as unknown as ConfigService;
}

describe('OrdersService', () => {
  let svc: OrdersService;
  let repo: OrdersRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new OrdersService(repo, makeConfig());
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
      svc = new OrdersService(repo, makeConfig(true));
      await svc.propose({ action: 'buy', symbol: 'ETH', address: '0xabc', chain: 'base', amount: '100' });
      expect(repo.transitionStatus).toHaveBeenCalledWith('order-1', 'approved', 'auto', undefined, expect.any(Object));
    });

    it('does NOT auto-approve SELL orders even when flag is set', async () => {
      svc = new OrdersService(repo, makeConfig(true));
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
      // pending cannot be directly cancelled, must go through reject or expire
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
});
