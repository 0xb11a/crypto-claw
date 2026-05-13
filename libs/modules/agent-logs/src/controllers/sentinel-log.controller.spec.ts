/**
 * Unit tests for SentinelLogController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SentinelLogController } from './sentinel-log.controller.js';
import type { AgentLogsService } from '../agent-logs.service.js';
import type { SentinelLogResponseDto } from '../dto/sentinel-log-response.dto.js';

const sample: SentinelLogResponseDto = {
  id: 2,
  check_type: 'price_check',
  positions_checked: 0,
  alerts_generated: 0,
  sells_executed: 0,
  status: 'ok',
  summary: null,
  created_at: null,
};

function makeSvc(): AgentLogsService {
  return {
    listSentinel: vi.fn().mockResolvedValue([sample]),
    getSentinelById: vi.fn().mockResolvedValue(sample),
    appendSentinel: vi.fn().mockResolvedValue(sample),
  } as unknown as AgentLogsService;
}

describe('SentinelLogController', () => {
  let ctrl: SentinelLogController;
  let svc: ReturnType<typeof makeSvc>;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new SentinelLogController(svc as unknown as AgentLogsService);
  });

  it('list() delegates to svc.listSentinel', async () => {
    const result = await ctrl.list({});
    expect(svc.listSentinel).toHaveBeenCalledWith({});
    expect(result).toEqual([sample]);
  });

  it('getById() delegates to svc.getSentinelById', async () => {
    const result = await ctrl.getById(2);
    expect(svc.getSentinelById).toHaveBeenCalledWith(2);
    expect(result).toEqual(sample);
  });

  it('append() delegates to svc.appendSentinel', async () => {
    const dto = { check_type: 'price_check', positions_checked: 3 };
    const result = await ctrl.append(dto);
    expect(svc.appendSentinel).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sample);
  });
});
