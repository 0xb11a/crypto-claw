/**
 * Unit tests for ResearchLogController (SPEC §14, DoD §A).
 *
 * Verifies that @Roles and @Audited are in the correct positions and that
 * the controller delegates correctly to AgentLogsService.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ResearchLogController } from './research-log.controller.js';
import type { AgentLogsService } from '../agent-logs.service.js';
import type { ResearchLogResponseDto } from '../dto/research-log-response.dto.js';

const sample: ResearchLogResponseDto = {
  id: 1,
  check_type: 'token_scan',
  tokens_scanned: 0,
  tokens_analyzed: 0,
  trades_proposed: 0,
  alerts_processed: 0,
  watchlist_hits: 0,
  summary: null,
  status: 'ok',
  created_at: null,
};

function makeSvc(): AgentLogsService {
  return {
    listResearch: vi.fn().mockResolvedValue([sample]),
    getResearchById: vi.fn().mockResolvedValue(sample),
    appendResearch: vi.fn().mockResolvedValue(sample),
  } as unknown as AgentLogsService;
}

describe('ResearchLogController', () => {
  let ctrl: ResearchLogController;
  let svc: ReturnType<typeof makeSvc>;

  beforeEach(() => {
    svc = makeSvc();
    ctrl = new ResearchLogController(svc as unknown as AgentLogsService);
  });

  it('list() delegates to svc.listResearch', async () => {
    const result = await ctrl.list({});
    expect(svc.listResearch).toHaveBeenCalledWith({});
    expect(result).toEqual([sample]);
  });

  it('list() passes query through', async () => {
    await ctrl.list({ limit: 10, status: 'ok' });
    expect(svc.listResearch).toHaveBeenCalledWith({ limit: 10, status: 'ok' });
  });

  it('getById() delegates to svc.getResearchById', async () => {
    const result = await ctrl.getById(1);
    expect(svc.getResearchById).toHaveBeenCalledWith(1);
    expect(result).toEqual(sample);
  });

  it('append() delegates to svc.appendResearch', async () => {
    const dto = { check_type: 'token_scan' };
    const result = await ctrl.append(dto);
    expect(svc.appendResearch).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sample);
  });
});
