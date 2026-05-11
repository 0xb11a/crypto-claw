import { Injectable } from '@nestjs/common';
import { HeartbeatRepository } from './heartbeat.repository.js';
import { IdlenessService } from './idleness.service.js';
import { HEARTBEAT_CADENCES, AGENT_HEARTBEAT_INTERVALS } from './cadences.js';
import type { HeartbeatListQueryDto } from './dto/heartbeat-list-query.dto.js';
import type {
  HeartbeatResponseDto,
  OverdueChecksResponseDto,
  OverdueCheckEntryDto,
} from './dto/heartbeat-response.dto.js';

/**
 * Heartbeat service — computes seconds_since, expected_cadence_seconds, idle_ok
 * identically to scripts/db-query.js get-heartbeats (ADR-0020 parity).
 *
 * idle_ok is PAPER_MODE-aware via IdlenessService.
 */
@Injectable()
export class HeartbeatService {
  constructor(
    private readonly repo: HeartbeatRepository,
    private readonly idleness: IdlenessService,
  ) {}

  private async computeRows(
    rows: Awaited<ReturnType<HeartbeatRepository['findAll']>>,
  ): Promise<HeartbeatResponseDto[]> {
    const now = Date.now();

    // Determine if we need executor / sentinel idleness checks
    const needsExecutor = rows.some((r) => r.agent === 'executor' && r.checkType === 'process_orders');
    const needsSentinel = rows.some((r) => r.agent === 'sentinel');

    let executorIdle: boolean | null = null;
    let sentinelIdle: boolean | null = null;

    if (needsExecutor) {
      const result = await this.idleness.checkExecutorWork();
      executorIdle = result.idle;
    }
    if (needsSentinel) {
      const result = await this.idleness.checkSentinelWork();
      sentinelIdle = result.idle;
    }

    return rows.map((row) => {
      let seconds_since: number | null = null;
      if (row.lastRun) {
        const ts = row.lastRun.endsWith('Z') ? row.lastRun : row.lastRun + 'Z';
        seconds_since = Math.round((now - Date.parse(ts)) / 1000);
      }

      const cadenceMin = HEARTBEAT_CADENCES[row.agent]?.[row.checkType] ?? null;
      // 0 means "runs every outer cycle" — substitute the agent's loop interval
      // so dead-agent detection (seconds_since > 2 × expected) works.
      const effectiveMin = cadenceMin === 0 ? (AGENT_HEARTBEAT_INTERVALS[row.agent] ?? null) : cadenceMin;

      let idle_ok = false;
      if (row.agent === 'executor' && row.checkType === 'process_orders') {
        idle_ok = executorIdle === true;
      } else if (row.agent === 'sentinel') {
        idle_ok = sentinelIdle === true;
      }

      return {
        agent: row.agent,
        check: row.checkType,
        last_run_at: row.lastRun,
        seconds_since,
        expected_cadence_seconds: effectiveMin === null ? null : effectiveMin * 60,
        idle_ok,
      };
    });
  }

  async list(query: HeartbeatListQueryDto): Promise<HeartbeatResponseDto[]> {
    const rows = await this.repo.findAll(query.agent);
    return this.computeRows(rows);
  }

  async getByAgent(agent: string): Promise<HeartbeatResponseDto[]> {
    const rows = await this.repo.findByAgent(agent);
    return this.computeRows(rows);
  }

  async getOverdueChecks(agent: string): Promise<OverdueChecksResponseDto> {
    const cadences = HEARTBEAT_CADENCES[agent];
    if (!cadences) {
      return { agent, overdue: [], not_yet_due: [] };
    }

    const rows = await this.repo.findByAgent(agent);
    const now = Date.now();
    const overdue: OverdueCheckEntryDto[] = [];
    const not_yet_due: OverdueCheckEntryDto[] = [];

    for (const row of rows) {
      const cadence = cadences[row.checkType] ?? 0;
      let minutes_since: number | null = null;
      if (row.lastRun) {
        const ts = row.lastRun.endsWith('Z') ? row.lastRun : row.lastRun + 'Z';
        minutes_since = Math.round((now - Date.parse(ts)) / 60000);
      }
      const entry = { check_type: row.checkType, minutes_since, cadence };
      if (minutes_since === null || (cadence > 0 && minutes_since > cadence)) {
        overdue.push(entry);
      } else {
        not_yet_due.push(entry);
      }
    }

    return { agent, overdue, not_yet_due };
  }

  async ping(agent: string, checkType: string): Promise<HeartbeatResponseDto> {
    const row = await this.repo.ping(agent, checkType);
    const now = Date.now();
    const cadenceMin = HEARTBEAT_CADENCES[agent]?.[checkType] ?? null;
    const effectiveMin = cadenceMin === 0 ? (AGENT_HEARTBEAT_INTERVALS[agent] ?? null) : cadenceMin;
    let seconds_since: number | null = null;
    if (row.lastRun) {
      const ts = row.lastRun.endsWith('Z') ? row.lastRun : row.lastRun + 'Z';
      seconds_since = Math.round((now - Date.parse(ts)) / 1000);
    }
    return {
      agent: row.agent,
      check: row.checkType,
      last_run_at: row.lastRun,
      seconds_since,
      expected_cadence_seconds: effectiveMin === null ? null : effectiveMin * 60,
      idle_ok: false,
    };
  }
}
