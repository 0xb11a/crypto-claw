import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '@cclaw/prisma';
import type { AppConfig } from '@cclaw/config';

/**
 * Idleness predicates for executor and sentinel agents.
 *
 * Re-implements scripts/agent-idleness.js in TypeScript using Prisma.
 * The predicates here are the contract — callers must not duplicate this logic.
 *
 * Demand-driven liveness: executor and sentinel agents are only invoked when
 * there is work to do. When idle, their heartbeat rows legitimately stop
 * refreshing, which would otherwise look like a dead agent. idle_ok=true
 * tells dead-agent detectors to suppress the alert.
 */
@Injectable()
export class IdlenessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configSvc: ConfigService,
  ) {}

  private get paperMode(): boolean {
    const cfg = this.configSvc.get<AppConfig>('');
    return (cfg as AppConfig | undefined)?.PAPER_MODE ?? false;
  }

  /**
   * Executor wakes when at least one order is in 'approved' status.
   * Queued multisig transactions are tracked by track-multisig.js, not the agent.
   */
  async checkExecutorWork(): Promise<{ pendingSells: number; pendingBuys: number; idle: boolean }> {
    const rows = await this.prisma.order.groupBy({
      by: ['action'],
      where: { status: 'approved' },
      _count: { action: true },
    });

    let pendingSells = 0;
    let pendingBuys = 0;

    for (const row of rows) {
      if (row.action === 'sell') pendingSells = row._count.action;
      if (row.action === 'buy') pendingBuys = row._count.action;
    }

    return {
      pendingSells,
      pendingBuys,
      idle: pendingSells === 0 && pendingBuys === 0,
    };
  }

  /**
   * Sentinel wakes when at least one position is in 'open' or 'partial_exit'.
   * paperMode picks the simulated table (mirrors scripts/agent-idleness.js).
   */
  async checkSentinelWork(): Promise<{ openPositions: number; idle: boolean }> {
    const paperMode = this.paperMode;
    let openPositions: number;

    if (paperMode) {
      openPositions = await this.prisma.paperPosition.count({
        where: { status: { in: ['open', 'partial_exit'] } },
      });
    } else {
      openPositions = await this.prisma.position.count({
        where: { status: { in: ['open', 'partial_exit'] } },
      });
    }

    return { openPositions, idle: openPositions === 0 };
  }
}
