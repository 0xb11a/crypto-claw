import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports from @prisma/client — allowed only in repository files.
// eslint-disable-next-line no-restricted-imports
import type { ResearchLog, SentinelLog, ExecutorLog, ObserverLog } from '@prisma/client';
import type { AppendResearchLogDto } from './dto/append-research-log.dto.js';
import type { AppendSentinelLogDto } from './dto/append-sentinel-log.dto.js';
import type { AppendExecutorLogDto } from './dto/append-executor-log.dto.js';
import type { AppendObserverLogDto } from './dto/append-observer-log.dto.js';
import type { ResearchLogResponseDto } from './dto/research-log-response.dto.js';
import type { SentinelLogResponseDto } from './dto/sentinel-log-response.dto.js';
import type { ExecutorLogResponseDto } from './dto/executor-log-response.dto.js';
import type { ObserverLogResponseDto } from './dto/observer-log-response.dto.js';
import type { AgentLogQueryDto } from './dto/agent-log-query.dto.js';

/** Union of all four agent log response shapes. */
export type AnyAgentLogRow =
  | ResearchLogResponseDto
  | SentinelLogResponseDto
  | ExecutorLogResponseDto
  | ObserverLogResponseDto;

/**
 * Agent logs repository — the only place Prisma queries for the four log tables live.
 *
 * Bug-for-bug parity notes:
 * - created_at is OMITTED from all create() calls so that SQLite's
 *   DEFAULT (datetime('now')) fires and produces the legacy format
 *   "YYYY-MM-DD HH:MM:SS" (not an ISO-Z string).
 * - The response DTOs use snake_case field names to match db-query.js SELECT * output.
 * - sentinel_log and executor_log had summary added via ALTER TABLE in migration 026;
 *   the new Prisma table includes it inline, so column ordering in the DB differs —
 *   but JSON deepEqual on field names/values is unaffected by column order.
 */
@Injectable()
export class AgentLogsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Row mappers — camelCase Prisma shape → snake_case response DTO
  // ---------------------------------------------------------------------------

  private mapResearch(row: ResearchLog): ResearchLogResponseDto {
    return {
      id: row.id,
      check_type: row.checkType,
      tokens_scanned: row.tokensScanned,
      tokens_analyzed: row.tokensAnalyzed,
      trades_proposed: row.tradesProposed,
      alerts_processed: row.alertsProcessed,
      watchlist_hits: row.watchlistHits,
      summary: row.summary ?? null,
      status: row.status,
      created_at: row.createdAt ?? null,
    };
  }

  private mapSentinel(row: SentinelLog): SentinelLogResponseDto {
    return {
      id: row.id,
      check_type: row.checkType,
      positions_checked: row.positionsChecked,
      alerts_generated: row.alertsGenerated,
      sells_executed: row.sellsExecuted,
      status: row.status,
      summary: row.summary ?? null,
      created_at: row.createdAt ?? null,
    };
  }

  private mapExecutor(row: ExecutorLog): ExecutorLogResponseDto {
    return {
      id: row.id,
      sell_orders_processed: row.sellOrdersProcessed,
      buy_orders_processed: row.buyOrdersProcessed,
      pending_checked: row.pendingChecked,
      success_count: row.successCount,
      fail_count: row.failCount,
      queued_count: row.queuedCount,
      status: row.status,
      summary: row.summary ?? null,
      created_at: row.createdAt ?? null,
    };
  }

  private mapObserver(row: ObserverLog): ObserverLogResponseDto {
    return {
      id: row.id,
      errors_analyzed: row.errorsAnalyzed,
      issues_created: row.issuesCreated,
      alerts_sent: row.alertsSent,
      summary: row.summary ?? null,
      status: row.status,
      created_at: row.createdAt ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Research log
  // ---------------------------------------------------------------------------

  /**
   * Append a research log row.
   *
   * created_at is intentionally omitted so SQLite's DEFAULT (datetime('now')) fires,
   * preserving the "YYYY-MM-DD HH:MM:SS" format for parity with the legacy db-query.js.
   */
  async appendResearch(dto: AppendResearchLogDto): Promise<ResearchLogResponseDto> {
    const row = await this.prisma.researchLog.create({
      data: {
        checkType: dto.check_type,
        tokensScanned: dto.tokens_scanned ?? 0,
        tokensAnalyzed: dto.tokens_analyzed ?? 0,
        tradesProposed: dto.trades_proposed ?? 0,
        alertsProcessed: dto.alerts_processed ?? 0,
        watchlistHits: dto.watchlist_hits ?? 0,
        summary: dto.summary ?? null,
        status: dto.status ?? 'ok',
        // createdAt deliberately omitted — let SQLite DEFAULT fire
      },
    });
    return this.mapResearch(row);
  }

  async findResearchById(id: number): Promise<ResearchLogResponseDto> {
    const row = await this.prisma.researchLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`ResearchLog row ${id} not found`);
    return this.mapResearch(row);
  }

  async findRecentResearch(query: AgentLogQueryDto): Promise<ResearchLogResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 500);
    const rows = await this.prisma.researchLog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.mapResearch(r));
  }

  // ---------------------------------------------------------------------------
  // Sentinel log
  // ---------------------------------------------------------------------------

  async appendSentinel(dto: AppendSentinelLogDto): Promise<SentinelLogResponseDto> {
    const row = await this.prisma.sentinelLog.create({
      data: {
        checkType: dto.check_type,
        positionsChecked: dto.positions_checked ?? 0,
        alertsGenerated: dto.alerts_generated ?? 0,
        sellsExecuted: dto.sells_executed ?? 0,
        summary: dto.summary ?? null,
        status: dto.status ?? 'ok',
        // createdAt deliberately omitted — let SQLite DEFAULT fire
      },
    });
    return this.mapSentinel(row);
  }

  async findSentinelById(id: number): Promise<SentinelLogResponseDto> {
    const row = await this.prisma.sentinelLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`SentinelLog row ${id} not found`);
    return this.mapSentinel(row);
  }

  async findRecentSentinel(query: AgentLogQueryDto): Promise<SentinelLogResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 500);
    const rows = await this.prisma.sentinelLog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.mapSentinel(r));
  }

  // ---------------------------------------------------------------------------
  // Executor log
  // ---------------------------------------------------------------------------

  async appendExecutor(dto: AppendExecutorLogDto): Promise<ExecutorLogResponseDto> {
    const row = await this.prisma.executorLog.create({
      data: {
        sellOrdersProcessed: dto.sell_orders_processed ?? 0,
        buyOrdersProcessed: dto.buy_orders_processed ?? 0,
        pendingChecked: dto.pending_checked ?? 0,
        successCount: dto.success_count ?? 0,
        failCount: dto.fail_count ?? 0,
        queuedCount: dto.queued_count ?? 0,
        summary: dto.summary ?? null,
        status: dto.status ?? 'ok',
        // createdAt deliberately omitted — let SQLite DEFAULT fire
      },
    });
    return this.mapExecutor(row);
  }

  async findExecutorById(id: number): Promise<ExecutorLogResponseDto> {
    const row = await this.prisma.executorLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`ExecutorLog row ${id} not found`);
    return this.mapExecutor(row);
  }

  async findRecentExecutor(query: AgentLogQueryDto): Promise<ExecutorLogResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 500);
    const rows = await this.prisma.executorLog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.mapExecutor(r));
  }

  // ---------------------------------------------------------------------------
  // Observer log
  // ---------------------------------------------------------------------------

  async appendObserver(dto: AppendObserverLogDto): Promise<ObserverLogResponseDto> {
    const row = await this.prisma.observerLog.create({
      data: {
        errorsAnalyzed: dto.errors_analyzed ?? 0,
        issuesCreated: dto.issues_created ?? 0,
        alertsSent: dto.alerts_sent ?? 0,
        summary: dto.summary ?? null,
        status: dto.status ?? 'ok',
        // createdAt deliberately omitted — let SQLite DEFAULT fire
      },
    });
    return this.mapObserver(row);
  }

  async findObserverById(id: number): Promise<ObserverLogResponseDto> {
    const row = await this.prisma.observerLog.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`ObserverLog row ${id} not found`);
    return this.mapObserver(row);
  }

  async findRecentObserver(query: AgentLogQueryDto): Promise<ObserverLogResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 500);
    const rows = await this.prisma.observerLog.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.since ? { createdAt: { gte: query.since } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.mapObserver(r));
  }
}
