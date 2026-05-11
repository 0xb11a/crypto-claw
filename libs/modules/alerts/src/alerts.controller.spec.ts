/**
 * Unit tests for AlertsController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AlertsController } from './alerts.controller.js';
import type { AlertsService } from './alerts.service.js';
import type { AlertResponseDto, AlertListResponseDto } from './dto/alert-response.dto.js';

const alert: AlertResponseDto = {
  id: 'alert-1',
  symbol: 'ETH',
  chain: 'base',
  alert_type: 'stop_loss',
  severity: 'high',
  processed: 0,
};

const ackedAlert: AlertResponseDto = { ...alert, processed: 1, processed_at: '2026-01-01T00:00:00Z' };

const listResponse: AlertListResponseDto = {
  data: [alert],
  pagination: { total: 1, limit: 50, cursor: 'alert-1', hasMore: false },
};

function makeService(overrides?: Partial<AlertsService>): AlertsService {
  return {
    list: vi.fn().mockResolvedValue(listResponse),
    getById: vi.fn().mockResolvedValue(alert),
    create: vi.fn().mockResolvedValue(alert),
    acknowledge: vi.fn().mockResolvedValue(ackedAlert),
    ...overrides,
  } as unknown as AlertsService;
}

describe('AlertsController', () => {
  let ctrl: AlertsController;
  let svc: AlertsService;

  beforeEach(() => {
    svc = makeService();
    ctrl = new AlertsController(svc);
  });

  describe('list()', () => {
    it('delegates to service and returns result', async () => {
      const result = await ctrl.list({});
      expect(svc.list).toHaveBeenCalledWith({});
      expect(result).toBe(listResponse);
    });

    it('passes unprocessed=true filter', async () => {
      await ctrl.list({ unprocessed: true });
      expect(svc.list).toHaveBeenCalledWith(expect.objectContaining({ unprocessed: true }));
    });
  });

  describe('getById()', () => {
    it('returns alert by ID', async () => {
      const result = await ctrl.getById('alert-1');
      expect(svc.getById).toHaveBeenCalledWith('alert-1');
      expect(result).toBe(alert);
    });

    it('propagates NotFoundException', async () => {
      const s = makeService({ getById: vi.fn().mockRejectedValue(new NotFoundException('Alert x not found')) });
      const c = new AlertsController(s);
      await expect(c.getById('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to service.create', async () => {
      const dto = { symbol: 'ETH', chain: 'base', alert_type: 'stop_loss', severity: 'high' as const };
      const result = await ctrl.create(dto);
      expect(svc.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(alert);
    });
  });

  describe('acknowledge()', () => {
    it('delegates to service.acknowledge and returns acked alert', async () => {
      const result = await ctrl.acknowledge('alert-1', {});
      expect(svc.acknowledge).toHaveBeenCalledWith('alert-1', {});
      expect(result).toBe(ackedAlert);
    });

    it('is idempotent — calling twice returns 200 both times', async () => {
      await ctrl.acknowledge('alert-1', {});
      const result = await ctrl.acknowledge('alert-1', {});
      expect(result.processed).toBe(1);
      expect(svc.acknowledge).toHaveBeenCalledTimes(2);
    });
  });
});
