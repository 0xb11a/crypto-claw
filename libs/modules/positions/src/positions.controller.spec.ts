/**
 * Unit tests for PositionsController.
 *
 * Tests that the controller correctly delegates to the service and passes
 * through results unchanged. Auth and validation are tested at the
 * integration layer (tests/integration/security/).
 *
 * DoD §A — every code change has a test.
 * SPEC §14 — ≥80% line coverage on libs/modules/positions/**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PositionsController } from './positions.controller.js';
import type { PositionsService } from './positions.service.js';
import type { PositionResponseDto, PositionListResponseDto } from './dto/position-response.dto.js';

const openPos: PositionResponseDto = {
  id: 'pos-1',
  symbol: 'ETH',
  address: '0xabc',
  chain: 'base',
  tier: 'conviction',
  entry_price: 2000,
  quantity: 0.5,
  entry_date: '2026-01-01',
  stop_loss: 1600,
  take_profit_levels: [2500, 3000],
  status: 'open',
  trailing_stop_active: 0,
  tp_levels_hit: [],
  mode: 'real',
};

const listResponse: PositionListResponseDto = {
  data: [openPos],
  pagination: { total: 1, limit: 50, cursor: 'pos-1', hasMore: false },
};

function makeService(overrides?: Partial<PositionsService>): PositionsService {
  return {
    list: vi.fn().mockResolvedValue(listResponse),
    getById: vi.fn().mockResolvedValue(openPos),
    create: vi.fn().mockResolvedValue(openPos),
    update: vi.fn().mockResolvedValue(openPos),
    close: vi.fn().mockResolvedValue({ ...openPos, status: 'closed' }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as PositionsService;
}

describe('PositionsController', () => {
  let ctrl: PositionsController;
  let svc: PositionsService;

  beforeEach(() => {
    svc = makeService();
    ctrl = new PositionsController(svc);
  });

  describe('list()', () => {
    it('delegates query to service and returns result', async () => {
      const result = await ctrl.list({ limit: 10 });
      expect(svc.list).toHaveBeenCalledWith({ limit: 10 });
      expect(result).toBe(listResponse);
    });

    it('passes mode=paper to service', async () => {
      await ctrl.list({ mode: 'paper' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paper' }));
    });

    it('passes status filter to service', async () => {
      await ctrl.list({ status: 'open' });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ status: 'open' }));
    });
  });

  describe('getById()', () => {
    it('returns position for valid id', async () => {
      const result = await ctrl.getById('pos-1', 'real');
      expect(svc.getById).toHaveBeenCalledWith('pos-1', 'real');
      expect(result).toBe(openPos);
    });

    it('defaults to real mode when mode is undefined', async () => {
      await ctrl.getById('pos-1', undefined);
      expect(svc.getById).toHaveBeenCalledWith('pos-1', 'real');
    });

    it('passes paper mode', async () => {
      await ctrl.getById('pos-1', 'paper');
      expect(svc.getById).toHaveBeenCalledWith('pos-1', 'paper');
    });

    it('propagates NotFoundException from service', async () => {
      (svc.getById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(ctrl.getById('bad-id', 'real')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to service and returns created position', async () => {
      const dto = {
        symbol: 'ETH',
        address: '0xabc',
        chain: 'base',
        tier: 'conviction' as const,
        entry_price: 2000,
        quantity: 0.5,
        stop_loss: 1600,
        take_profit_levels: [2500, 3000],
      };
      const result = await ctrl.create(dto);
      expect(svc.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(openPos);
    });
  });

  describe('update()', () => {
    it('delegates to service with correct id, dto, and mode', async () => {
      const result = await ctrl.update('pos-1', { stop_loss: 1500 }, 'real');
      expect(svc.update).toHaveBeenCalledWith('pos-1', { stop_loss: 1500 }, 'real');
      expect(result).toBe(openPos);
    });

    it('defaults mode to real when undefined', async () => {
      await ctrl.update('pos-1', { stop_loss: 1500 }, undefined);
      expect(svc.update).toHaveBeenCalledWith('pos-1', { stop_loss: 1500 }, 'real');
    });
  });

  describe('close()', () => {
    it('delegates close call to service', async () => {
      const result = await ctrl.close('pos-1', { exit_price: 2500 }, 'real');
      expect(svc.close).toHaveBeenCalledWith('pos-1', { exit_price: 2500 }, 'real');
      expect(result.status).toBe('closed');
    });

    it('defaults mode to real when undefined', async () => {
      await ctrl.close('pos-1', { exit_price: 2500 }, undefined);
      expect(svc.close).toHaveBeenCalledWith('pos-1', { exit_price: 2500 }, 'real');
    });

    it('propagates NotFoundException for already-closed position', async () => {
      (svc.close as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('already closed'));
      await expect(ctrl.close('pos-1', { exit_price: 2500 }, 'real')).rejects.toThrow(NotFoundException);
    });
  });

  describe('delete()', () => {
    it('delegates delete call to service', async () => {
      await ctrl.delete('pos-1', 'real');
      expect(svc.delete).toHaveBeenCalledWith('pos-1', 'real');
    });

    it('defaults mode to real when undefined', async () => {
      await ctrl.delete('pos-1', undefined);
      expect(svc.delete).toHaveBeenCalledWith('pos-1', 'real');
    });

    it('propagates NotFoundException from service', async () => {
      (svc.delete as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(ctrl.delete('bad-id', 'real')).rejects.toThrow(NotFoundException);
    });
  });
});
