/**
 * Unit tests for HeartbeatController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { HeartbeatController } from './heartbeat.controller.js';
import type { HeartbeatService } from './heartbeat.service.js';
import type { HeartbeatResponseDto, OverdueChecksResponseDto } from './dto/heartbeat-response.dto.js';

const hbRow: HeartbeatResponseDto = {
  agent: 'executor',
  check: 'process_orders',
  last_run_at: '2026-01-01T00:00:00Z',
  seconds_since: 120,
  expected_cadence_seconds: 60,
  idle_ok: false,
};

const overdueResp: OverdueChecksResponseDto = {
  agent: 'executor',
  overdue: [{ check_type: 'process_orders', minutes_since: 10, cadence: 0 }],
  not_yet_due: [],
};

function makeService(overrides?: Partial<HeartbeatService>): HeartbeatService {
  return {
    list: vi.fn().mockResolvedValue([hbRow]),
    getByAgent: vi.fn().mockResolvedValue([hbRow]),
    getOverdueChecks: vi.fn().mockResolvedValue(overdueResp),
    ping: vi.fn().mockResolvedValue(hbRow),
    ...overrides,
  } as unknown as HeartbeatService;
}

describe('HeartbeatController', () => {
  let ctrl: HeartbeatController;
  let svc: HeartbeatService;

  beforeEach(() => {
    svc = makeService();
    ctrl = new HeartbeatController(svc);
  });

  describe('list()', () => {
    it('delegates to service.list', async () => {
      const result = await ctrl.list({});
      expect(svc.list).toHaveBeenCalledWith({});
      expect(result).toEqual([hbRow]);
    });

    it('passes agent filter', async () => {
      await ctrl.list({ agent: 'executor' });
      expect(svc.list).toHaveBeenCalledWith({ agent: 'executor' });
    });
  });

  describe('getByAgent()', () => {
    it('delegates to service.getByAgent', async () => {
      const result = await ctrl.getByAgent('executor');
      expect(svc.getByAgent).toHaveBeenCalledWith('executor');
      expect(result).toEqual([hbRow]);
    });

    it('propagates NotFoundException', async () => {
      const s = makeService({ getByAgent: vi.fn().mockRejectedValue(new NotFoundException('Agent x not found')) });
      const c = new HeartbeatController(s);
      await expect(c.getByAgent('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('getOverdue()', () => {
    it('delegates to service.getOverdueChecks', async () => {
      const result = await ctrl.getOverdue('executor');
      expect(svc.getOverdueChecks).toHaveBeenCalledWith('executor');
      expect(result).toBe(overdueResp);
    });
  });

  describe('ping()', () => {
    it('delegates to service.ping with agent and checkType', async () => {
      const result = await ctrl.ping('executor', 'process_orders', {});
      expect(svc.ping).toHaveBeenCalledWith('executor', 'process_orders');
      expect(result).toBe(hbRow);
    });
  });
});
