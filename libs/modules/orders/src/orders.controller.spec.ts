/**
 * Unit tests for OrdersController.
 *
 * Tests that the controller correctly delegates to the service.
 * Auth and validation are tested at the integration layer
 * (tests/integration/security/).
 *
 * DoD §A — every code change has a test.
 * SPEC §14 — ≥80% line coverage on libs/modules/orders/**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException, ConflictException } from '@nestjs/common';
import { OrdersController } from './orders.controller.js';
import type { OrdersService } from './orders.service.js';
import type { OrderResponseDto, OrderListResponseDto } from './dto/order-response.dto.js';
import type { AuthenticatedUser } from '@cclaw/auth';

const pendingOrder: OrderResponseDto = {
  id: 'order-1',
  action: 'buy',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  amount: '100',
  status: 'pending',
};

const approvedOrder: OrderResponseDto = { ...pendingOrder, status: 'approved' };
const rejectedOrder: OrderResponseDto = { ...pendingOrder, status: 'rejected' };
const cancelledOrder: OrderResponseDto = { ...pendingOrder, status: 'cancelled' };

const listResponse: OrderListResponseDto = {
  data: [pendingOrder],
  pagination: { total: 1, limit: 50, cursor: 'order-1', hasMore: false },
};

const enqueuedResponse = { jobId: 'execute-order-order-1', orderId: 'order-1', status: 'enqueued' as const };
const paperResponse = { jobId: null, orderId: 'order-1', status: 'paper_executed' as const };

function makeService(overrides?: Partial<OrdersService>): OrdersService {
  return {
    list: vi.fn().mockResolvedValue(listResponse),
    getById: vi.fn().mockResolvedValue(pendingOrder),
    propose: vi.fn().mockResolvedValue(pendingOrder),
    approve: vi.fn().mockResolvedValue(approvedOrder),
    reject: vi.fn().mockResolvedValue(rejectedOrder),
    cancel: vi.fn().mockResolvedValue(cancelledOrder),
    retry: vi.fn().mockResolvedValue(approvedOrder),
    execute: vi.fn().mockResolvedValue(enqueuedResponse),
    ...overrides,
  } as unknown as OrdersService;
}

describe('OrdersController', () => {
  let ctrl: OrdersController;
  let svc: OrdersService;

  beforeEach(() => {
    svc = makeService();
    ctrl = new OrdersController(svc);
  });

  describe('list()', () => {
    it('delegates query to service and returns result', async () => {
      const result = await ctrl.list({ limit: 10 });
      expect(svc.list).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toBe(listResponse);
    });

    it('passes pending=true filter to service', async () => {
      await ctrl.list({ pending: true });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ pending: true }));
    });

    it('passes action filter to service', async () => {
      await ctrl.list({ action: 'buy' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ action: 'buy' }));
    });

    it('passes status filter to service', async () => {
      await ctrl.list({ status: 'approved' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'approved' }));
    });
  });

  describe('getById()', () => {
    it('returns order for valid id', async () => {
      const result = await ctrl.getById('order-1');
      expect(svc.getById).toHaveBeenCalledWith('order-1');
      expect(result).toBe(pendingOrder);
    });

    it('propagates NotFoundException from service', async () => {
      (svc.getById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(ctrl.getById('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('propose()', () => {
    it('delegates to service and returns created order', async () => {
      const dto = {
        action: 'buy' as const,
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        amount: '100',
      };
      // Controller's propose() accepts a req object with optional user.
      // Pass a minimal fake req to simulate the @Req() injection (P7 PR-C1).
      const user: AuthenticatedUser = { identity: 'LOOP', role: 'agent' };
      const fakeReq = { user };
      const result = await ctrl.propose(dto, fakeReq);
      expect(svc.propose).toHaveBeenCalledWith(dto, 'LOOP');
      expect(result).toBe(pendingOrder);
    });

    it('passes undefined identity when req.user is absent', async () => {
      const dto = {
        action: 'buy' as const,
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        amount: '100',
      };
      const fakeReq: { user?: AuthenticatedUser } = {}; // no user
      await ctrl.propose(dto, fakeReq);
      expect(svc.propose).toHaveBeenCalledWith(dto, undefined);
    });
  });

  describe('approve()', () => {
    it('delegates to service with id and dto', async () => {
      const result = await ctrl.approve('order-1', { by: 'human' });
      expect(svc.approve).toHaveBeenCalledWith('order-1', { by: 'human' });
      expect(result).toBe(approvedOrder);
    });

    it('propagates NotFoundException from service', async () => {
      (svc.approve as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(ctrl.approve('bad-id', {})).rejects.toThrow(NotFoundException);
    });

    it('propagates ConflictException for invalid transition', async () => {
      (svc.approve as ReturnType<typeof vi.fn>).mockRejectedValue(new ConflictException('invalid transition'));
      await expect(ctrl.approve('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('reject()', () => {
    it('delegates to service with id and dto', async () => {
      const result = await ctrl.reject('order-1', { reason: 'bad token' });
      expect(svc.reject).toHaveBeenCalledWith('order-1', { reason: 'bad token' });
      expect(result).toBe(rejectedOrder);
    });

    it('propagates ConflictException for invalid transition', async () => {
      (svc.reject as ReturnType<typeof vi.fn>).mockRejectedValue(new ConflictException('invalid transition'));
      await expect(ctrl.reject('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('cancel()', () => {
    it('delegates to service with id and dto', async () => {
      const result = await ctrl.cancel('order-1', { reason: 'operator cancelled' });
      expect(svc.cancel).toHaveBeenCalledWith('order-1', { reason: 'operator cancelled' });
      expect(result).toBe(cancelledOrder);
    });

    it('propagates ConflictException for invalid transition', async () => {
      (svc.cancel as ReturnType<typeof vi.fn>).mockRejectedValue(new ConflictException('invalid transition'));
      await expect(ctrl.cancel('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('retry()', () => {
    it('delegates to service with id and dto', async () => {
      const result = await ctrl.retry('order-1', { by: 'human' });
      expect(svc.retry).toHaveBeenCalledWith('order-1', { by: 'human' });
      expect(result).toBe(approvedOrder);
    });

    it('propagates ConflictException when retrying non-failed order', async () => {
      (svc.retry as ReturnType<typeof vi.fn>).mockRejectedValue(new ConflictException('only failed orders'));
      await expect(ctrl.retry('order-1', {})).rejects.toThrow(ConflictException);
    });
  });

  describe('execute()', () => {
    it('delegates to service and returns 202 response in real mode', async () => {
      const result = await ctrl.execute('order-1', {});
      expect(svc.execute).toHaveBeenCalledWith('order-1');
      expect(result).toBe(enqueuedResponse);
    });

    it('returns paper_executed response in paper mode', async () => {
      (svc.execute as ReturnType<typeof vi.fn>).mockResolvedValue(paperResponse);
      const result = await ctrl.execute('order-1', {});
      expect(result.status).toBe('paper_executed');
      expect(result.jobId).toBeNull();
    });

    it('propagates ConflictException for non-approved order', async () => {
      (svc.execute as ReturnType<typeof vi.fn>).mockRejectedValue(
        new ConflictException('only approved orders can be executed'),
      );
      await expect(ctrl.execute('order-1', {})).rejects.toThrow(ConflictException);
    });

    it('propagates NotFoundException for missing order', async () => {
      (svc.execute as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(ctrl.execute('order-1', {})).rejects.toThrow(NotFoundException);
    });
  });
});
