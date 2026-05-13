/**
 * Unit tests for ExecutorLogController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ExecutorLogController } from './executor-log.controller.js';
import type { AgentLogsService } from '../agent-logs.service.js';
import type { ExecutorLogResponseDto } from '../dto/executor-log-response.dto.js';

const sample: ExecutorLogResponseDto = {
  id: 3,
  sell_orders_processed: 0,
  buy_orders_processed: 0,
  pending_checked: 0,
  success_count: 0,
  fail_count: 0,
  queued_count: 0,
  status: 'ok',
  summary: null,
  created_at: null,
};

function makeSvc(): AgentLogsService {
  return {
    listExecutor: vi.fn().mockResolvedValue([sample]),
    getExecutorById: vi.fn().mockResolvedValue(sample),
    appendExecutor: vi.fn().mockResolvedValue(sample),
  } as unknown as AgentLogsService;
}

describe('ExecutorLogController', () => {
  let ctrl: ExecutorLogController;
  let svc: ReturnType<typeof makeSvc>;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new ExecutorLogController(svc as unknown as AgentLogsService);
  });

  it('list() delegates to svc.listExecutor', async () => {
    const result = await ctrl.list({});
    expect(svc.listExecutor).toHaveBeenCalledWith({});
    expect(result).toEqual([sample]);
  });

  it('getById() delegates to svc.getExecutorById', async () => {
    const result = await ctrl.getById(3);
    expect(svc.getExecutorById).toHaveBeenCalledWith(3);
    expect(result).toEqual(sample);
  });

  it('append() delegates to svc.appendExecutor', async () => {
    const dto = { sell_orders_processed: 2, buy_orders_processed: 1 };
    const result = await ctrl.append(dto);
    expect(svc.appendExecutor).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sample);
  });
});
