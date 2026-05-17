/**
 * Unit tests for AlertsController (SPEC §14, DoD §A).
 * send() cases added per P5c plan §D item 10 (ADR-0028).
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
    send: vi.fn().mockResolvedValue({ accepted: true } as const),
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

  // -------------------------------------------------------------------------
  // send() — ADR-0028, SPEC §14, DoD §A, plan §D item 10
  //
  // The controller unit test exercises the delegation contract only.
  // Auth/validation/audit-row assertions live in the integration spec
  // tests/integration/security/alerts-adversarial.spec.ts.
  // -------------------------------------------------------------------------

  describe('send()', () => {
    const validDto = {
      type: 'rug_warning',
      agent: 'sentinel',
      message: 'rug detected on TOKEN/base',
    };

    it('delegates to service.send and returns { accepted: true }', async () => {
      const result = await ctrl.send(validDto);
      expect(svc.send).toHaveBeenCalledWith(validDto);
      expect(result).toEqual({ accepted: true });
    });

    it('passes the DTO through unchanged (type, agent, message)', async () => {
      const dto = { type: 'model_failure', agent: 'executor', message: 'OpenAI timeout' };
      await ctrl.send(dto);
      expect(svc.send).toHaveBeenCalledWith(dto);
    });

    it('passes the optional data field through to service.send', async () => {
      const dto = { type: 'system_health', agent: 'observer', message: 'bg stale', data: { cycle: 5 } };
      await ctrl.send(dto);
      expect(svc.send).toHaveBeenCalledWith(expect.objectContaining({ data: { cycle: 5 } }));
    });

    it('returns { accepted: true } regardless of what service.send returns internally', async () => {
      // Even if the service somehow resolves differently, controller passes it through
      (svc.send as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ accepted: true });
      const result = await ctrl.send(validDto);
      expect(result.accepted).toBe(true);
    });

    it('propagates service errors (NotificationsService should not throw — but if it does, controller surfaces it)', async () => {
      (svc.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unexpected'));
      await expect(ctrl.send(validDto)).rejects.toThrow('unexpected');
    });
  });
});
