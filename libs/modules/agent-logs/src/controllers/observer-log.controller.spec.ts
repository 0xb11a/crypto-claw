/**
 * Unit tests for ObserverLogController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ObserverLogController } from './observer-log.controller.js';
import type { AgentLogsService } from '../agent-logs.service.js';
import type { ObserverLogResponseDto } from '../dto/observer-log-response.dto.js';

const sample: ObserverLogResponseDto = {
  id: 4,
  errors_analyzed: 0,
  issues_created: 0,
  alerts_sent: 0,
  summary: null,
  status: 'ok',
  created_at: null,
};

function makeSvc(): AgentLogsService {
  return {
    listObserver: vi.fn().mockResolvedValue([sample]),
    getObserverById: vi.fn().mockResolvedValue(sample),
    appendObserver: vi.fn().mockResolvedValue(sample),
  } as unknown as AgentLogsService;
}

describe('ObserverLogController', () => {
  let ctrl: ObserverLogController;
  let svc: ReturnType<typeof makeSvc>;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new ObserverLogController(svc as unknown as AgentLogsService);
  });

  it('list() delegates to svc.listObserver', async () => {
    const result = await ctrl.list({});
    expect(svc.listObserver).toHaveBeenCalledWith({});
    expect(result).toEqual([sample]);
  });

  it('getById() delegates to svc.getObserverById', async () => {
    const result = await ctrl.getById(4);
    expect(svc.getObserverById).toHaveBeenCalledWith(4);
    expect(result).toEqual(sample);
  });

  it('append() delegates to svc.appendObserver', async () => {
    const dto = { errors_analyzed: 1, alerts_sent: 1 };
    const result = await ctrl.append(dto);
    expect(svc.appendObserver).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sample);
  });
});
