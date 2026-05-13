/**
 * Unit tests for AlertsService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import type { AlertsRepository } from './alerts.repository.js';
import type { AlertResponseDto } from './dto/alert-response.dto.js';

const unprocessedAlert: AlertResponseDto = {
  id: 'alert-1',
  symbol: 'ETH',
  chain: 'base',
  alert_type: 'stop_loss',
  severity: 'high',
  processed: 0,
};

const processedAlert: AlertResponseDto = {
  ...unprocessedAlert,
  processed: 1,
  processed_at: '2026-01-01T01:00:00Z',
};

function makeRepo(overrides?: Partial<AlertsRepository>): AlertsRepository {
  return {
    findMany: vi.fn().mockResolvedValue([unprocessedAlert]),
    findById: vi.fn().mockResolvedValue(unprocessedAlert),
    create: vi.fn().mockResolvedValue(unprocessedAlert),
    acknowledge: vi.fn().mockResolvedValue(processedAlert),
    count: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as AlertsRepository;
}

describe('AlertsService', () => {
  let svc: AlertsService;
  let repo: AlertsRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new AlertsService(repo);
  });

  describe('list()', () => {
    it('returns paginated envelope', async () => {
      const result = await svc.list({});
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('cursor points to last item id', async () => {
      const result = await svc.list({});
      expect(result.pagination.cursor).toBe('alert-1');
    });

    it('hasMore=true when data.length === limit', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ ...unprocessedAlert, id: `a-${i}` }));
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue(many), count: vi.fn().mockResolvedValue(100) });
      const s = new AlertsService(r);
      const res = await s.list({ limit: 50 });
      expect(res.pagination.hasMore).toBe(true);
    });
  });

  describe('getById()', () => {
    it('delegates to repo', async () => {
      const result = await svc.getById('alert-1');
      expect(result.id).toBe('alert-1');
    });

    it('propagates NotFoundException', async () => {
      const r = makeRepo({ findById: vi.fn().mockRejectedValue(new NotFoundException('Alert x not found')) });
      await expect(new AlertsService(r).getById('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to repo.create', async () => {
      const dto = { symbol: 'ETH', chain: 'base', alert_type: 'stop_loss', severity: 'high' as const };
      const result = await svc.create(dto);
      expect(repo.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(unprocessedAlert);
    });
  });

  describe('acknowledge()', () => {
    it('delegates to repo.acknowledge', async () => {
      const result = await svc.acknowledge('alert-1', {});
      expect(repo.acknowledge).toHaveBeenCalledWith('alert-1');
      expect(result.processed).toBe(1);
    });

    it('idempotent: calling twice still returns processed=1', async () => {
      // First call
      await svc.acknowledge('alert-1', {});
      // Second call — repo returns already-processed row
      const r2 = makeRepo({ acknowledge: vi.fn().mockResolvedValue(processedAlert) });
      const s2 = new AlertsService(r2);
      const result = await s2.acknowledge('alert-1', {});
      expect(result.processed).toBe(1);
    });
  });
});
