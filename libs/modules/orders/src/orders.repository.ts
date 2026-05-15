import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports from @prisma/client are allowed here because these are purely
// type imports with no runtime @prisma/client access. The actual Prisma client is
// accessed via PrismaService.
// eslint-disable-next-line no-restricted-imports
import type { Order } from '@prisma/client';
// eslint-disable-next-line no-restricted-imports
import { Prisma } from '@prisma/client';
import type { ProposeOrderDto } from './dto/propose-order.dto.js';
import type { OrderListQueryDto } from './dto/order-list-query.dto.js';
import type { OrderResponseDto } from './dto/order-response.dto.js';
import { randomUUID } from 'node:crypto';

/**
 * Orders repository — the only place Prisma queries for orders live.
 *
 * JSON-string fields (take_profit_levels) are parsed/serialised at this
 * boundary to maintain byte-identical parity with db-query.js (OPEN-5).
 */
@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private parseJsonArray(value: string | null | undefined): number[] | null {
    if (value == null) return null;
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : null;
    } catch {
      return null;
    }
  }

  private toJsonString(arr: number[] | undefined | null): string | null {
    if (arr == null) return null;
    return JSON.stringify(arr);
  }

  private mapOrder(row: Order): OrderResponseDto {
    return {
      id: row.id,
      action: row.action,
      symbol: row.symbol,
      name: row.name ?? undefined,
      address: row.address,
      chain: row.chain,
      amount: row.amount,
      percent_of_portfolio: row.percentOfPortfolio ?? undefined,
      tier: row.tier ?? undefined,
      entry_price: row.entryPrice ?? undefined,
      stop_loss: row.stopLoss ?? undefined,
      take_profit_levels: this.parseJsonArray(row.takeProfitLevels),
      analysis_score: row.analysisScore ?? undefined,
      risk_score: row.riskScore ?? undefined,
      reasoning: row.reasoning ?? undefined,
      reason: row.reason ?? undefined,
      urgency: row.urgency ?? undefined,
      approved_at: row.approvedAt ?? undefined,
      approved_by: row.approvedBy ?? undefined,
      status: row.status,
      status_reason: row.statusReason ?? undefined,
      status_changed_at: row.statusChangedAt ?? undefined,
      status_changed_by: row.statusChangedBy ?? undefined,
      updated_at: row.updatedAt ?? undefined,
      tg_message_id: row.tgMessageId ?? undefined,
      created_at: row.createdAt ?? undefined,
    };
  }

  // ---------------------------------------------------------------------------
  // Query methods
  // ---------------------------------------------------------------------------

  async findMany(query: OrderListQueryDto): Promise<OrderResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 200);
    // Legacy semantics (SPEC §19 #2 / db-query.js line 605):
    // --pending returns status IN ('pending', 'approved') — i.e. "awaiting execution".
    // The executor agent reads this list; silently missing 'approved' orders would break
    // the order-execution pipeline during the rewrite window.
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.pending ? { status: { in: ['pending', 'approved'] } } : {}),
      ...(query.cursor ? { id: { gt: query.cursor } } : {}),
    };

    const rows = await this.prisma.order.findMany({
      where,
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapOrder(r));
  }

  async findById(id: string): Promise<OrderResponseDto> {
    const row = await this.prisma.order.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Order ${id} not found`);
    return this.mapOrder(row);
  }

  async create(dto: ProposeOrderDto): Promise<OrderResponseDto> {
    const id = randomUUID();
    const now = new Date().toISOString();

    const row = await this.prisma.order.create({
      data: {
        id,
        action: dto.action,
        symbol: dto.symbol,
        name: dto.name,
        address: dto.address,
        chain: dto.chain,
        amount: dto.amount,
        percentOfPortfolio: dto.percent_of_portfolio,
        tier: dto.tier,
        entryPrice: dto.entry_price,
        stopLoss: dto.stop_loss,
        takeProfitLevels: this.toJsonString(dto.take_profit_levels),
        analysisScore: dto.analysis_score,
        riskScore: dto.risk_score,
        reasoning: dto.reasoning,
        reason: dto.reason,
        urgency: dto.urgency,
        status: 'pending',
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.mapOrder(row);
  }

  /**
   * Atomic state-machine transition.
   *
   * Updates status + audit fields in a single Prisma write.
   * Does NOT validate the transition — that is the service's responsibility.
   */
  async transitionStatus(
    id: string,
    newStatus: string,
    by: string,
    reason?: string,
    extraFields?: Partial<{
      approvedAt: string;
      approvedBy: string;
    }>,
  ): Promise<OrderResponseDto> {
    const now = new Date().toISOString();
    const row = await this.prisma.order.update({
      where: { id },
      data: {
        status: newStatus,
        statusReason: reason ?? null,
        statusChangedAt: now,
        statusChangedBy: by,
        updatedAt: now,
        ...extraFields,
      },
    });
    return this.mapOrder(row);
  }

  async count(query: Omit<OrderListQueryDto, 'limit' | 'cursor'>): Promise<number> {
    // Mirror the same legacy semantics as findMany: --pending = IN ('pending', 'approved')
    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.pending ? { status: { in: ['pending', 'approved'] } } : {}),
    };
    return this.prisma.order.count({ where });
  }

  /**
   * Atomic approval-state transition for the approval-bot (ADR-0027).
   *
   * Updates the order only when its current status matches `fromStatus`.
   * If the record does not exist or its status has already changed (race:
   * executor already picked it up, operator clicked twice, or a concurrent
   * legacy `approval-bot.js` handled it first), Prisma throws P2025 and
   * this method returns `{ updated: false }` — the caller must NOT retry.
   *
   * For `approve` transitions, sets `approvedAt` and `approvedBy` in addition
   * to the standard status audit fields.
   *
   * @param id         - Order UUID.
   * @param fromStatus - Required current status (optimistic-lock guard).
   * @param toStatus   - Target status ('approved' or 'rejected').
   * @param approvedBy - Actor string written to `approved_by` / `status_changed_by`.
   * @returns `{ updated: true, order }` on success; `{ updated: false }` on P2025.
   */
  async transitionApproval(
    id: string,
    fromStatus: string,
    toStatus: string,
    approvedBy: string,
  ): Promise<{ updated: boolean; order?: OrderResponseDto }> {
    const now = new Date().toISOString();
    const extraFields: Partial<{ approvedAt: string; approvedBy: string }> =
      toStatus === 'approved' ? { approvedAt: now, approvedBy } : {};

    try {
      const row = await this.prisma.order.update({
        where: {
          id,
          // Prisma compound where: only matches if status is still fromStatus.
          // If status has changed, Prisma throws P2025 (record not found).
          status: fromStatus,
        },
        data: {
          status: toStatus,
          statusChangedAt: now,
          statusChangedBy: approvedBy,
          updatedAt: now,
          ...extraFields,
        },
      });
      return { updated: true, order: this.mapOrder(row) };
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') {
        // Status mismatch or record missing — optimistic-lock race, not an error.
        return { updated: false };
      }
      throw err;
    }
  }
}
