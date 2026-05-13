import { Injectable } from '@nestjs/common';
import { AgentLogsRepository } from './agent-logs.repository.js';
import type { AppendResearchLogDto } from './dto/append-research-log.dto.js';
import type { AppendSentinelLogDto } from './dto/append-sentinel-log.dto.js';
import type { AppendExecutorLogDto } from './dto/append-executor-log.dto.js';
import type { AppendObserverLogDto } from './dto/append-observer-log.dto.js';
import type { ResearchLogResponseDto } from './dto/research-log-response.dto.js';
import type { SentinelLogResponseDto } from './dto/sentinel-log-response.dto.js';
import type { ExecutorLogResponseDto } from './dto/executor-log-response.dto.js';
import type { ObserverLogResponseDto } from './dto/observer-log-response.dto.js';
import type { AgentLogQueryDto } from './dto/agent-log-query.dto.js';

/**
 * Agent logs service — thin orchestration layer between controllers and the repository.
 *
 * Each method delegates directly to the appropriate per-table repository method.
 * No business logic lives here; validation is enforced by the class-validator DTOs.
 */
@Injectable()
export class AgentLogsService {
  constructor(private readonly repo: AgentLogsRepository) {}

  // ---------------------------------------------------------------------------
  // Research
  // ---------------------------------------------------------------------------

  appendResearch(dto: AppendResearchLogDto): Promise<ResearchLogResponseDto> {
    return this.repo.appendResearch(dto);
  }

  getResearchById(id: number): Promise<ResearchLogResponseDto> {
    return this.repo.findResearchById(id);
  }

  listResearch(query: AgentLogQueryDto): Promise<ResearchLogResponseDto[]> {
    return this.repo.findRecentResearch(query);
  }

  // ---------------------------------------------------------------------------
  // Sentinel
  // ---------------------------------------------------------------------------

  appendSentinel(dto: AppendSentinelLogDto): Promise<SentinelLogResponseDto> {
    return this.repo.appendSentinel(dto);
  }

  getSentinelById(id: number): Promise<SentinelLogResponseDto> {
    return this.repo.findSentinelById(id);
  }

  listSentinel(query: AgentLogQueryDto): Promise<SentinelLogResponseDto[]> {
    return this.repo.findRecentSentinel(query);
  }

  // ---------------------------------------------------------------------------
  // Executor
  // ---------------------------------------------------------------------------

  appendExecutor(dto: AppendExecutorLogDto): Promise<ExecutorLogResponseDto> {
    return this.repo.appendExecutor(dto);
  }

  getExecutorById(id: number): Promise<ExecutorLogResponseDto> {
    return this.repo.findExecutorById(id);
  }

  listExecutor(query: AgentLogQueryDto): Promise<ExecutorLogResponseDto[]> {
    return this.repo.findRecentExecutor(query);
  }

  // ---------------------------------------------------------------------------
  // Observer
  // ---------------------------------------------------------------------------

  appendObserver(dto: AppendObserverLogDto): Promise<ObserverLogResponseDto> {
    return this.repo.appendObserver(dto);
  }

  getObserverById(id: number): Promise<ObserverLogResponseDto> {
    return this.repo.findObserverById(id);
  }

  listObserver(query: AgentLogQueryDto): Promise<ObserverLogResponseDto[]> {
    return this.repo.findRecentObserver(query);
  }
}
