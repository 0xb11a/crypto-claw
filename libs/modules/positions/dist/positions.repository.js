'use strict';
var __decorate =
  (this && this.__decorate) ||
  function (decorators, target, key, desc) {
    var c = arguments.length,
      r = c < 3 ? target : desc === null ? (desc = Object.getOwnPropertyDescriptor(target, key)) : desc,
      d;
    if (typeof Reflect === 'object' && typeof Reflect.decorate === 'function')
      r = Reflect.decorate(decorators, target, key, desc);
    else
      for (var i = decorators.length - 1; i >= 0; i--)
        if ((d = decorators[i])) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return (c > 3 && r && Object.defineProperty(target, key, r), r);
  };
var __metadata =
  (this && this.__metadata) ||
  function (k, v) {
    if (typeof Reflect === 'object' && typeof Reflect.metadata === 'function') return Reflect.metadata(k, v);
  };
Object.defineProperty(exports, '__esModule', { value: true });
exports.PositionsRepository = void 0;
const common_1 = require('@nestjs/common');
const prisma_1 = require('@cclaw/prisma');
const node_crypto_1 = require('node:crypto');
/**
 * Positions repository — the only place Prisma queries for positions live.
 *
 * Discriminates on `mode` to select `positions` vs `paper_positions` table.
 * JSON-string fields (take_profit_levels, tp_levels_hit) are parsed/serialised
 * at this boundary to maintain byte-identical parity with db-query.js (OPEN-5).
 */
let PositionsRepository = class PositionsRepository {
  prisma;
  constructor(prisma) {
    this.prisma = prisma;
  }
  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  /** Parse a JSON-string column to a typed array, falling back to []. */
  parseJsonArray(value) {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  /** Serialise an array to a JSON string for storage. */
  toJsonString(arr) {
    return JSON.stringify(arr ?? []);
  }
  /** Map a raw Position DB row to the response shape. */
  mapPosition(row, mode) {
    return {
      ...row,
      take_profit_levels: this.parseJsonArray(row.takeProfitLevels),
      tp_levels_hit: this.parseJsonArray(row.tpLevelsHit),
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
  mapPaperPosition(row) {
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
      tp_levels_hit: this.parseJsonArray(row.tpLevelsHit),
      created_at: row.createdAt ?? undefined,
      updated_at: row.updatedAt ?? undefined,
      mode: 'paper',
    };
  }
  // ---------------------------------------------------------------------------
  // Public query methods
  // ---------------------------------------------------------------------------
  async findMany(query) {
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
  async findById(id, mode = 'real') {
    if (mode === 'paper') {
      const row = await this.prisma.paperPosition.findUnique({ where: { id } });
      if (!row) throw new common_1.NotFoundException(`Paper position ${id} not found`);
      return this.mapPaperPosition(row);
    }
    const row = await this.prisma.position.findUnique({ where: { id } });
    if (!row) throw new common_1.NotFoundException(`Position ${id} not found`);
    return this.mapPosition(row, mode);
  }
  async create(dto) {
    const mode = dto.mode ?? 'real';
    const id = (0, node_crypto_1.randomUUID)();
    const now = new Date().toISOString();
    const entryDate = dto.entry_date ?? new Date().toISOString().split('T')[0];
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
  async update(id, dto, mode = 'real') {
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
  async closePosition(id, dto, mode = 'real') {
    const now = new Date().toISOString();
    const exitDate = dto.exit_date ?? new Date().toISOString().split('T')[0];
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
  async delete(id, mode = 'real') {
    if (mode === 'paper') {
      await this.prisma.paperPosition.delete({ where: { id } });
      return;
    }
    await this.prisma.position.delete({ where: { id } });
  }
  /** Count positions — used for pagination totals. */
  async count(query) {
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
};
exports.PositionsRepository = PositionsRepository;
exports.PositionsRepository = PositionsRepository = __decorate(
  [(0, common_1.Injectable)(), __metadata('design:paramtypes', [prisma_1.PrismaService])],
  PositionsRepository,
);
//# sourceMappingURL=positions.repository.js.map
