import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports — no runtime @prisma/client access outside libs/prisma.
// eslint-disable-next-line no-restricted-imports
import type { HeartbeatState } from '@prisma/client';

/** Raw heartbeat row without computed fields. */
export interface HeartbeatRow {
  agent: string;
  checkType: string;
  lastRun: string | null;
}

/**
 * Heartbeat repository — the only place Prisma queries for heartbeat_state live.
 */
@Injectable()
export class HeartbeatRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapRow(row: HeartbeatState): HeartbeatRow {
    return {
      agent: row.agent,
      checkType: row.checkType,
      lastRun: row.lastRun ?? null,
    };
  }

  async findAll(agent?: string): Promise<HeartbeatRow[]> {
    const rows = await this.prisma.heartbeatState.findMany({
      where: agent ? { agent } : undefined,
    });
    return rows.map((r) => this.mapRow(r));
  }

  async findByAgent(agent: string): Promise<HeartbeatRow[]> {
    const rows = await this.prisma.heartbeatState.findMany({ where: { agent } });
    if (rows.length === 0) throw new NotFoundException(`No heartbeat rows found for agent '${agent}'`);
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Upsert a heartbeat row (create if not exists, update lastRun otherwise).
   *
   * Returns the updated row.
   */
  async ping(agent: string, checkType: string): Promise<HeartbeatRow> {
    const now = new Date().toISOString();
    const row = await this.prisma.heartbeatState.upsert({
      where: { agent_checkType: { agent, checkType } },
      update: { lastRun: now },
      create: { agent, checkType, lastRun: now },
    });
    return this.mapRow(row);
  }
}
