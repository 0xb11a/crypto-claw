/**
 * Unit tests for AgentLogsService (SPEC §14, DoD §A).
 *
 * Verifies delegation from service to repository for all four agent types.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AgentLogsService } from './agent-logs.service.js';
import type { AgentLogsRepository } from './agent-logs.repository.js';
import type { ResearchLogResponseDto } from './dto/research-log-response.dto.js';
import type { SentinelLogResponseDto } from './dto/sentinel-log-response.dto.js';
import type { ExecutorLogResponseDto } from './dto/executor-log-response.dto.js';
import type { ObserverLogResponseDto } from './dto/observer-log-response.dto.js';

const sampleResearch: ResearchLogResponseDto = {
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
const sampleSentinel: SentinelLogResponseDto = {
  id: 2,
  check_type: 'price_check',
  positions_checked: 0,
  alerts_generated: 0,
  sells_executed: 0,
  status: 'ok',
  summary: null,
  created_at: null,
};
const sampleExecutor: ExecutorLogResponseDto = {
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
const sampleObserver: ObserverLogResponseDto = {
  id: 4,
  errors_analyzed: 0,
  issues_created: 0,
  alerts_sent: 0,
  summary: null,
  status: 'ok',
  created_at: null,
};

function makeRepo(): AgentLogsRepository {
  return {
    appendResearch: vi.fn().mockResolvedValue(sampleResearch),
    findResearchById: vi.fn().mockResolvedValue(sampleResearch),
    findRecentResearch: vi.fn().mockResolvedValue([sampleResearch]),
    appendSentinel: vi.fn().mockResolvedValue(sampleSentinel),
    findSentinelById: vi.fn().mockResolvedValue(sampleSentinel),
    findRecentSentinel: vi.fn().mockResolvedValue([sampleSentinel]),
    appendExecutor: vi.fn().mockResolvedValue(sampleExecutor),
    findExecutorById: vi.fn().mockResolvedValue(sampleExecutor),
    findRecentExecutor: vi.fn().mockResolvedValue([sampleExecutor]),
    appendObserver: vi.fn().mockResolvedValue(sampleObserver),
    findObserverById: vi.fn().mockResolvedValue(sampleObserver),
    findRecentObserver: vi.fn().mockResolvedValue([sampleObserver]),
  } as unknown as AgentLogsRepository;
}

describe('AgentLogsService', () => {
  let svc: AgentLogsService;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    repo = makeRepo();
    svc = new AgentLogsService(repo as unknown as AgentLogsRepository);
  });

  // Research
  it('appendResearch delegates to repo.appendResearch', async () => {
    const dto = { check_type: 'token_scan' };
    const result = await svc.appendResearch(dto);
    expect(repo.appendResearch).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sampleResearch);
  });

  it('getResearchById delegates to repo.findResearchById', async () => {
    await svc.getResearchById(1);
    expect(repo.findResearchById).toHaveBeenCalledWith(1);
  });

  it('listResearch delegates to repo.findRecentResearch', async () => {
    const query = { limit: 10 };
    await svc.listResearch(query);
    expect(repo.findRecentResearch).toHaveBeenCalledWith(query);
  });

  // Sentinel
  it('appendSentinel delegates to repo.appendSentinel', async () => {
    const dto = { check_type: 'price_check' };
    const result = await svc.appendSentinel(dto);
    expect(repo.appendSentinel).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sampleSentinel);
  });

  it('getSentinelById delegates to repo.findSentinelById', async () => {
    await svc.getSentinelById(2);
    expect(repo.findSentinelById).toHaveBeenCalledWith(2);
  });

  it('listSentinel delegates to repo.findRecentSentinel', async () => {
    await svc.listSentinel({});
    expect(repo.findRecentSentinel).toHaveBeenCalledWith({});
  });

  // Executor
  it('appendExecutor delegates to repo.appendExecutor', async () => {
    const dto = { sell_orders_processed: 1 };
    const result = await svc.appendExecutor(dto);
    expect(repo.appendExecutor).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sampleExecutor);
  });

  it('getExecutorById delegates to repo.findExecutorById', async () => {
    await svc.getExecutorById(3);
    expect(repo.findExecutorById).toHaveBeenCalledWith(3);
  });

  it('listExecutor delegates to repo.findRecentExecutor', async () => {
    await svc.listExecutor({ status: 'error' });
    expect(repo.findRecentExecutor).toHaveBeenCalledWith({ status: 'error' });
  });

  // Observer
  it('appendObserver delegates to repo.appendObserver', async () => {
    const dto = { errors_analyzed: 2 };
    const result = await svc.appendObserver(dto);
    expect(repo.appendObserver).toHaveBeenCalledWith(dto);
    expect(result).toEqual(sampleObserver);
  });

  it('getObserverById delegates to repo.findObserverById', async () => {
    await svc.getObserverById(4);
    expect(repo.findObserverById).toHaveBeenCalledWith(4);
  });

  it('listObserver delegates to repo.findRecentObserver', async () => {
    await svc.listObserver({});
    expect(repo.findRecentObserver).toHaveBeenCalledWith({});
  });
});
