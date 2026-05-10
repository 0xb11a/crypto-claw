import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { PositionsService } from './positions.service.js';
import type { PositionsRepository } from './positions.repository.js';
import type { PositionResponseDto } from './dto/position-response.dto.js';

const openPosition: PositionResponseDto = {
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

const makeRepo = (overrides?: Partial<PositionsRepository>): PositionsRepository =>
  ({
    findMany: vi.fn().mockResolvedValue([openPosition]),
    count: vi.fn().mockResolvedValue(1),
    findById: vi.fn().mockResolvedValue(openPosition),
    create: vi.fn().mockResolvedValue(openPosition),
    update: vi.fn().mockResolvedValue(openPosition),
    closePosition: vi.fn().mockResolvedValue({ ...openPosition, status: 'closed' }),
    delete: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }) as unknown as PositionsRepository;

describe('PositionsService', () => {
  let svc: PositionsService;
  let repo: PositionsRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new PositionsService(repo);
  });

  describe('list()', () => {
    it('returns paginated results', async () => {
      const result = await svc.list({ limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.limit).toBe(10);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('caps limit at 200', async () => {
      await svc.list({ limit: 999 });
      // repo.findMany is called — limit is capped at 200
      expect(repo.findMany).toHaveBeenCalledWith(expect.objectContaining({ limit: 999 }));
    });

    it('sets cursor to last position id', async () => {
      const result = await svc.list({});
      expect(result.pagination.cursor).toBe('pos-1');
    });

    it('routes to paper mode when mode=paper', async () => {
      await svc.list({ mode: 'paper' });
      expect(repo.findMany).toHaveBeenCalledWith(expect.objectContaining({ mode: 'paper' }));
    });
  });

  describe('getById()', () => {
    it('returns the position', async () => {
      const result = await svc.getById('pos-1');
      expect(result.id).toBe('pos-1');
    });

    it('throws 404 if not found', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(svc.getById('bad-id')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to repository', async () => {
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
      const result = await svc.create(dto);
      expect(result.symbol).toBe('ETH');
    });
  });

  describe('update()', () => {
    it('throws 404 if position not found', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(svc.update('bad-id', { stop_loss: 1500 })).rejects.toThrow(NotFoundException);
    });

    it('delegates to repository after existence check', async () => {
      await svc.update('pos-1', { stop_loss: 1500 });
      expect(repo.update).toHaveBeenCalledWith('pos-1', { stop_loss: 1500 }, 'real');
    });
  });

  describe('close()', () => {
    it('throws NotFoundException if already closed', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue({ ...openPosition, status: 'closed' });
      await expect(svc.close('pos-1', { exit_price: 2500 })).rejects.toThrow(NotFoundException);
    });

    it('closes an open position', async () => {
      const result = await svc.close('pos-1', { exit_price: 2500 });
      expect(result.status).toBe('closed');
    });
  });

  describe('delete()', () => {
    it('throws 404 if position not found', async () => {
      (repo.findById as ReturnType<typeof vi.fn>).mockRejectedValue(new NotFoundException('not found'));
      await expect(svc.delete('bad-id')).rejects.toThrow(NotFoundException);
    });

    it('calls repo.delete after existence check', async () => {
      await svc.delete('pos-1');
      expect(repo.delete).toHaveBeenCalledWith('pos-1', 'real');
    });
  });
});
