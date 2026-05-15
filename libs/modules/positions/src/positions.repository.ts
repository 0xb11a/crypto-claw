import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only imports from @prisma/client are allowed here because this repository
// lives in libs/modules (not libs/prisma), but these are purely type imports with
// no runtime @prisma/client access. The actual Prisma client is accessed via PrismaService.
// eslint-disable-next-line no-restricted-imports
import type { Position, PaperPosition } from '@prisma/client';
import type { CreatePositionDto } from './dto/create-position.dto.js';
import type { UpdatePositionDto } from './dto/update-position.dto.js';
import type { ClosePositionDto } from './dto/close-position.dto.js';
import type { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionResponseDto } from './dto/position-response.dto.js';
import { randomUUID } from 'node:crypto';

type Mode = 'real' | 'paper';

/**
 * Positions repository — the only place Prisma queries for positions live.
 *
 * Discriminates on `mode` to select `positions` vs `paper_positions` table.
 * JSON-string fields (take_profit_levels, tp_levels_hit) are parsed/serialised
 * at this boundary to maintain byte-identical parity with db-query.js (OPEN-5).
 */
@Injectable()
export class PositionsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Parse a JSON-string column to a typed array, falling back to []. */
  private parseJsonArray(value: string | null | undefined): number[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as number[]) : [];
    } catch {
      return [];
    }
  }

  /** Serialise an array to a JSON string for storage. */
  private toJsonString(arr: number[] | undefined): string {
    return JSON.stringify(arr ?? []);
  }

  /** Map a raw Position DB row to the response shape. */
  private mapPosition(row: Position, mode: Mode): PositionResponseDto {
    return {
      ...row,
      take_profit_levels: this.parseJsonArray(row.takeProfitLevels),
      // tp_levels_hit is NOT parsed — legacy db-query.js returns the raw TEXT value.
      // Agent code calls JSON.parse(tp_levels_hit); we must match the raw string shape.
      tp_levels_hit: row.tpLevelsHit ?? '[]',
      trailing_stop_active: row.trailingStopActive,
      entry_date: row.entryDate,
      entry_price: row.entryPrice,
      current_price: row.currentPrice ?? undefined,
      value_usd: row.valueUsd ?? undefined,
      percent_of_portfolio: row.percentOfPortfolio ?? undefined,
      stop_loss: row.stopLoss,
      onchain_balance: row.onchainBalance ?? undefined,
      last_synced_at: row.lastSyncedAt ?? undefined,
      exit_price: row.exitPrice ?? undefined,
      exit_date: row.exitDate ?? undefined,
      pnl_percent: row.pnlPercent ?? undefined,
      pnl_usd: row.pnlUsd ?? undefined,
      exit_reason: row.exitReason ?? undefined,
      max_price_since_entry: row.maxPriceSinceEntry ?? undefined,
      trailing_stop_pct: row.trailingStopPct ?? undefined,
      created_at: row.createdAt ?? undefined,
      updated_at: row.updatedAt ?? undefined,
      mode,
    };
  }

  /** Map a raw PaperPosition DB row to the response shape. */
  private mapPaperPosition(row: PaperPosition): PositionResponseDto {
    return {
      id: row.id,
      symbol: row.symbol,
      name: undefined,
      address: row.address,
      chain: row.chain,
      tier: row.tier,
      entry_price: row.entryPrice,
      current_price: row.currentPrice ?? undefined,
      quantity: row.quantity,
      value_usd: row.valueUsd ?? undefined,
      percent_of_portfolio: undefined,
      entry_date: row.entryDate,
      stop_loss: row.stopLoss,
      take_profit_levels: this.parseJsonArray(row.takeProfitLevels),
      narrative: undefined,
      status: row.status,
      notes: undefined,
      onchain_balance: undefined,
      last_synced_at: undefined,
      exit_price: row.exitPrice ?? undefined,
      exit_date: row.exitDate ?? undefined,
      pnl_percent: row.pnlPercent ?? undefined,
      pnl_usd: row.pnlUsd ?? undefined,
      exit_reason: row.exitReason ?? undefined,
      max_price_since_entry: row.maxPriceSinceEntry ?? undefined,
      trailing_stop_pct: row.trailingStopPct ?? undefined,
      trailing_stop_active: row.trailingStopActive,
      // tp_levels_hit is NOT parsed — match legacy db-query.js raw TEXT shape.
      tp_levels_hit: row.tpLevelsHit ?? '[]',
      created_at: row.createdAt ?? undefined,
      updated_at: row.updatedAt ?? undefined,
      mode: 'paper',
    };
  }

  // ---------------------------------------------------------------------------
  // Public query methods
  // ---------------------------------------------------------------------------

  async findMany(query: PositionListQueryDto): Promise<PositionResponseDto[]> {
    const mode = query.mode ?? 'real';
    const limit = Math.min(query.limit ?? 50, 200);

    if (mode === 'paper') {
      const rows = await this.prisma.paperPosition.findMany({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.symbol ? { symbol: { contains: query.symbol } } : {}),
          ...(query.chain ? { chain: query.chain } : {}),
          ...(query.cursor ? { id: { gt: query.cursor } } : {}),
        },
        take: limit,
        orderBy: { createdAt: 'desc' },
      });
      return rows.map((r) => this.mapPaperPosition(r));
    }

    const rows = await this.prisma.position.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.symbol ? { symbol: { contains: query.symbol } } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
        ...(query.cursor ? { id: { gt: query.cursor } } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapPosition(r, mode));
  }

  async findById(id: string, mode: Mode = 'real'): Promise<PositionResponseDto> {
    if (mode === 'paper') {
      const row = await this.prisma.paperPosition.findUnique({ where: { id } });
      if (!row) throw new NotFoundException(`Paper position ${id} not found`);
      return this.mapPaperPosition(row);
    }

    const row = await this.prisma.position.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Position ${id} not found`);
    return this.mapPosition(row, mode);
  }

  async create(dto: CreatePositionDto): Promise<PositionResponseDto> {
    const mode = dto.mode ?? 'real';
    const id = randomUUID();
    const now = new Date().toISOString();
    const entryDate = dto.entry_date ?? new Date().toISOString().split('T')[0]!;
    const tpLevels = this.toJsonString(dto.take_profit_levels);

    if (mode === 'paper') {
      const row = await this.prisma.paperPosition.create({
        data: {
          id,
          symbol: dto.symbol,
          address: dto.address,
          chain: dto.chain,
          tier: dto.tier,
          entryPrice: dto.entry_price,
          quantity: dto.quantity,
          entryDate,
          stopLoss: dto.stop_loss,
          takeProfitLevels: tpLevels,
          createdAt: now,
          updatedAt: now,
        },
      });
      return this.mapPaperPosition(row);
    }

    const row = await this.prisma.position.create({
      data: {
        id,
        symbol: dto.symbol,
        name: dto.name,
        address: dto.address,
        chain: dto.chain,
        tier: dto.tier,
        entryPrice: dto.entry_price,
        quantity: dto.quantity,
        entryDate,
        stopLoss: dto.stop_loss,
        takeProfitLevels: tpLevels,
        narrative: dto.narrative,
        notes: dto.notes,
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.mapPosition(row, mode);
  }

  async update(id: string, dto: UpdatePositionDto, mode: Mode = 'real'): Promise<PositionResponseDto> {
    const now = new Date().toISOString();

    if (mode === 'paper') {
      const row = await this.prisma.paperPosition.update({
        where: { id },
        data: {
          ...(dto.current_price !== undefined ? { currentPrice: dto.current_price } : {}),
          ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
          ...(dto.value_usd !== undefined ? { valueUsd: dto.value_usd } : {}),
          ...(dto.stop_loss !== undefined ? { stopLoss: dto.stop_loss } : {}),
          ...(dto.take_profit_levels !== undefined
            ? { takeProfitLevels: this.toJsonString(dto.take_profit_levels) }
            : {}),
          ...(dto.status !== undefined ? { status: dto.status } : {}),
          ...(dto.trailing_stop_pct !== undefined ? { trailingStopPct: dto.trailing_stop_pct } : {}),
          ...(dto.max_price_since_entry !== undefined ? { maxPriceSinceEntry: dto.max_price_since_entry } : {}),
          ...(dto.tp_levels_hit !== undefined ? { tpLevelsHit: this.toJsonString(dto.tp_levels_hit) } : {}),
          updatedAt: now,
        },
      });
      return this.mapPaperPosition(row);
    }

    const row = await this.prisma.position.update({
      where: { id },
      data: {
        ...(dto.current_price !== undefined ? { currentPrice: dto.current_price } : {}),
        ...(dto.quantity !== undefined ? { quantity: dto.quantity } : {}),
        ...(dto.value_usd !== undefined ? { valueUsd: dto.value_usd } : {}),
        ...(dto.stop_loss !== undefined ? { stopLoss: dto.stop_loss } : {}),
        ...(dto.take_profit_levels !== undefined
          ? { takeProfitLevels: this.toJsonString(dto.take_profit_levels) }
          : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
        ...(dto.narrative !== undefined ? { narrative: dto.narrative } : {}),
        ...(dto.trailing_stop_pct !== undefined ? { trailingStopPct: dto.trailing_stop_pct } : {}),
        ...(dto.max_price_since_entry !== undefined ? { maxPriceSinceEntry: dto.max_price_since_entry } : {}),
        ...(dto.tp_levels_hit !== undefined ? { tpLevelsHit: this.toJsonString(dto.tp_levels_hit) } : {}),
        ...(dto.onchain_balance !== undefined ? { onchainBalance: dto.onchain_balance } : {}),
        ...(dto.last_synced_at !== undefined ? { lastSyncedAt: dto.last_synced_at } : {}),
        updatedAt: now,
      },
    });
    return this.mapPosition(row, mode);
  }

  async closePosition(id: string, dto: ClosePositionDto, mode: Mode = 'real'): Promise<PositionResponseDto> {
    const now = new Date().toISOString();
    const exitDate = dto.exit_date ?? new Date().toISOString().split('T')[0]!;

    if (mode === 'paper') {
      const row = await this.prisma.paperPosition.update({
        where: { id },
        data: {
          status: 'closed',
          exitPrice: dto.exit_price,
          exitDate,
          exitReason: dto.exit_reason,
          pnlPercent: dto.pnl_percent,
          pnlUsd: dto.pnl_usd,
          updatedAt: now,
        },
      });
      return this.mapPaperPosition(row);
    }

    const row = await this.prisma.position.update({
      where: { id },
      data: {
        status: 'closed',
        exitPrice: dto.exit_price,
        exitDate,
        exitReason: dto.exit_reason,
        pnlPercent: dto.pnl_percent,
        pnlUsd: dto.pnl_usd,
        updatedAt: now,
      },
    });
    return this.mapPosition(row, mode);
  }

  async delete(id: string, mode: Mode = 'real'): Promise<void> {
    if (mode === 'paper') {
      await this.prisma.paperPosition.delete({ where: { id } });
      return;
    }
    await this.prisma.position.delete({ where: { id } });
  }

  // ---------------------------------------------------------------------------
  // Multisig-tracking methods (P3g2 PR-D)
  // ---------------------------------------------------------------------------

  /**
   * Delete a draft position by ID.
   *
   * Only deletes positions with `status === 'draft'`. Throws an error if the
   * position is not in draft status (guards against accidental deletion of
   * open or closed positions).
   *
   * Bug-for-bug port of `scripts/track-multisig.js:handleRejected` (BUY rejection
   * branch: `DELETE FROM positions WHERE id = ?`), with the safety guard that
   * the new code only deletes when `status === 'draft'`.
   *
   * @param id - Position ID.
   * @throws Error if position is not in 'draft' status.
   */
  async deleteDraft(id: string): Promise<void> {
    const row = await this.prisma.position.findUnique({ where: { id } });
    if (!row) {
      throw new NotFoundException(`Position ${id} not found`);
    }
    if (row.status !== 'draft') {
      throw new Error(`Cannot deleteDraft: position ${id} has status '${row.status}' (expected 'draft')`);
    }
    await this.prisma.position.delete({ where: { id } });
  }

  /** Count positions — used for pagination totals. */
  async count(query: Omit<PositionListQueryDto, 'limit' | 'cursor'>): Promise<number> {
    const mode = query.mode ?? 'real';
    if (mode === 'paper') {
      return this.prisma.paperPosition.count({
        where: {
          ...(query.status ? { status: query.status } : {}),
          ...(query.symbol ? { symbol: { contains: query.symbol } } : {}),
          ...(query.chain ? { chain: query.chain } : {}),
        },
      });
    }
    return this.prisma.position.count({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.symbol ? { symbol: { contains: query.symbol } } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
      },
    });
  }
}
