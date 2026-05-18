import { Injectable } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only import from @prisma/client — allowed only in repository files.
// eslint-disable-next-line no-restricted-imports
import type { PortfolioMeta, PortfolioSync } from '@prisma/client';
import { Prisma } from '@prisma/client'; // eslint-disable-line no-restricted-imports
import { getAllChains } from '@cclaw/chain';
import type { SetMetaDto } from './dto/set-meta.dto.js';
import type { MetaResponseDto } from './dto/meta-response.dto.js';
import type { SetCashDto } from './dto/set-cash.dto.js';
import type { CashByChainDto } from './dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from './dto/cash-breakdown.dto.js';
import type { GasResponseDto } from './dto/gas-query.dto.js';
import type { SyncStatusQueryDto } from './dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from './dto/portfolio-sync-response.dto.js';
import type { PortfolioResponseDto, PortfolioSingleChainResponseDto } from './dto/portfolio-response.dto.js';
import type { TradeStatsResponseDto } from './dto/trade-stats-response.dto.js';

/**
 * System repository — Prisma queries for portfolio_meta and portfolio_sync.
 *
 * Parity notes:
 * - get-meta: returns { key, value: row?.value || null } (null when key missing).
 * - set-meta: upserts via ON CONFLICT (Prisma upsert).
 * - get-cash --chain X: returns { chain, cash } (float parsed from TEXT value).
 * - get-cash (no arg): returns flat { [chain]: number, total: number } from
 *   all keys matching 'cash_<chain>' prefix — matches getAllCashBreakdown().
 * - get-gas --chain: returns { chain, symbol, balance, price, value_usd } from
 *   portfolio_meta key 'gas_<chain>' (stored as JSON text).
 * - set-cash: upserts 'cash_<chain>' key.
 * - get-sync-status: returns portfolio_sync rows ordered by synced_at DESC.
 * - updated_at is NOT passed to upsert so SQLite DEFAULT fires correctly.
 *
 * Note: getMeta, getCashByChain, getAllCash return base shapes WITHOUT _mode.
 * The service layer (SystemService) appends _mode to match legacy output()
 * behavior (ADR-0020). The Omit<> return types make the split explicit.
 */
@Injectable()
export class SystemRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ---------------------------------------------------------------------------
  // Meta
  // ---------------------------------------------------------------------------

  /**
   * Seed the `safe_id` key if it does not already exist.
   *
   * Replicates the legacy db.js migration 001 INSERT:
   *   INSERT INTO portfolio_meta (key, value) VALUES ('safe_id', '${SAFE_ID}')
   *
   * Uses `upsert` with empty update block so a pre-existing value is never
   * overwritten (idempotent; safe to call on every boot).
   */
  async seedSafeId(safeId: string): Promise<void> {
    await this.prisma.portfolioMeta.upsert({
      where: { key: 'safe_id' },
      update: {},
      create: { key: 'safe_id', value: safeId },
    });
  }

  /** Get a portfolio_meta row by key. Returns null value if key is missing. */
  async getMeta(key: string): Promise<Omit<MetaResponseDto, '_mode'>> {
    const row = await this.prisma.portfolioMeta.findUnique({ where: { key } });
    return { key, value: row?.value ?? null };
  }

  /** Upsert a portfolio_meta key/value. */
  async setMeta(dto: SetMetaDto): Promise<{ ok: boolean; key: string; value: string }> {
    await this.prisma.portfolioMeta.upsert({
      where: { key: dto.key },
      create: { key: dto.key, value: dto.value },
      update: { value: dto.value },
    });
    return { ok: true, key: dto.key, value: dto.value };
  }

  // ---------------------------------------------------------------------------
  // Cash
  // ---------------------------------------------------------------------------

  /** Get cash for a specific chain. Returns 0 if key is missing. */
  async getCashByChain(chain: string): Promise<Omit<CashByChainDto, '_mode'>> {
    const key = `cash_${chain}`;
    const row = await this.prisma.portfolioMeta.findUnique({ where: { key } });
    const cash = parseFloat(row?.value ?? '0');
    return { chain, cash };
  }

  /**
   * Get cash for all chains.
   * Matches legacy getAllCashBreakdown(db) — flat { [chain]: number, total: number }.
   * _mode is NOT included here; the service layer appends it (ADR-0020).
   */
  async getAllCash(): Promise<Omit<CashBreakdownDto, '_mode'>> {
    const rows = await this.prisma.portfolioMeta.findMany({
      where: { key: { startsWith: 'cash_' } },
    });
    const result: Record<string, number> = {};
    let total = 0;
    for (const row of rows) {
      const chain = row.key.slice('cash_'.length);
      if (!chain) continue; // skip exact 'cash_' prefix match
      const val = parseFloat(row.value ?? '0');
      result[chain] = val;
      total += val;
    }
    result['total'] = total;
    return result;
  }

  /** Set cash for a chain. */
  async setCash(dto: SetCashDto): Promise<{ ok: boolean; chain: string; cash: number }> {
    const key = `cash_${dto.chain}`;
    const val = String(dto.amount);
    await this.prisma.portfolioMeta.upsert({
      where: { key },
      create: { key, value: val },
      update: { value: val },
    });
    return { ok: true, chain: dto.chain, cash: dto.amount };
  }

  // ---------------------------------------------------------------------------
  // Gas
  // ---------------------------------------------------------------------------

  /**
   * Get gas token info for a chain.
   * Reads 'gas_<chain>' meta key (stored as JSON).
   */
  async getGas(chain: string): Promise<GasResponseDto> {
    const key = `gas_${chain}`;
    const row = await this.prisma.portfolioMeta.findUnique({ where: { key } });
    if (!row?.value) {
      return { chain, symbol: null, balance: 0, price: 0, value_usd: 0 };
    }
    // Value is stored as JSON text by portfolio-load scripts; shape varies by chain.
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(row.value) as Record<string, unknown>;
    } catch (err) {
      // Malformed JSON in gas_<chain> meta value — return zero-shape rather than 500.
      // This can happen if a portfolio-load script wrote a partial/corrupt value.
      console.warn(`SystemRepository.getGas: malformed gas_${chain} JSON: ${(err as Error).message}`);
      return { chain, symbol: null, balance: 0, price: 0, value_usd: 0 };
    }
    return {
      chain,
      symbol: (parsed['symbol'] as string | undefined) ?? null,
      balance: (parsed['balance'] as number | undefined) ?? 0,
      price: (parsed['price'] as number | undefined) ?? 0,
      value_usd: (parsed['value_usd'] as number | undefined) ?? 0,
    };
  }

  // ---------------------------------------------------------------------------
  // Portfolio sync
  // ---------------------------------------------------------------------------

  private mapSync(row: PortfolioSync): PortfolioSyncResponseDto {
    return {
      id: row.id,
      chain: row.chain,
      provider: row.provider,
      trigger: row.trigger,
      status: row.status,
      positions_synced: row.positionsSynced,
      positions_closed: row.positionsClosed,
      positions_discovered: row.positionsDiscovered,
      error: row.error ?? null,
      synced_at: row.syncedAt ?? null,
    };
  }

  /** List portfolio sync history. Matches legacy get-sync-status. */
  async getSyncStatus(query: SyncStatusQueryDto): Promise<PortfolioSyncResponseDto[]> {
    const limit = Math.min(query.limit ?? 20, 100);
    const rows = await this.prisma.portfolioSync.findMany({
      where: query.chain ? { chain: query.chain } : undefined,
      orderBy: { syncedAt: 'desc' },
      take: limit,
    });
    return rows.map((r) => this.mapSync(r));
  }

  // ---------------------------------------------------------------------------
  // Portfolio
  // ---------------------------------------------------------------------------

  /**
   * Build a portfolio snapshot for a single chain.
   *
   * Mirrors the legacy db-query.js `get-portfolio --chain X` branch
   * (lines 457-478). Discriminates on `mode` to select positions vs
   * paper_positions. Returns open/partial_exit positions only.
   */
  async getPortfolioForChain(
    chain: string,
    mode: 'real' | 'paper',
  ): Promise<Omit<PortfolioSingleChainResponseDto, '_mode'>> {
    const safeIdRow = await this.prisma.portfolioMeta.findUnique({ where: { key: 'safe_id' } });
    const safeId = safeIdRow?.value ?? null;

    const cashKey = `cash_${chain}`;
    const cashRow = await this.prisma.portfolioMeta.findUnique({ where: { key: cashKey } });
    const cash = parseFloat(cashRow?.value ?? '0');

    const depositKey = `total_deposited_${chain}`;
    const depositRow = await this.prisma.portfolioMeta.findUnique({ where: { key: depositKey } });
    const totalDeposited = parseFloat(depositRow?.value ?? '0');

    let positions: unknown[];
    if (mode === 'paper') {
      const rows = await this.prisma.paperPosition.findMany({
        where: { chain, status: { in: ['open', 'partial_exit'] } },
        orderBy: { createdAt: 'desc' },
      });
      positions = rows.map((p) => ({
        ...p,
        take_profit_levels: (() => {
          try {
            return JSON.parse(p.takeProfitLevels) as unknown;
          } catch {
            return [];
          }
        })(),
      }));
    } else {
      const rows = await this.prisma.position.findMany({
        where: { chain, status: { in: ['open', 'partial_exit'] } },
        orderBy: { createdAt: 'desc' },
      });
      positions = rows.map((p) => ({
        ...p,
        take_profit_levels: (() => {
          try {
            return JSON.parse(p.takeProfitLevels) as unknown;
          } catch {
            return [];
          }
        })(),
      }));
    }

    const positionValue = (
      positions as Array<{ currentPrice?: number | null; entryPrice?: number; quantity?: number }>
    ).reduce((sum, p) => sum + (p.currentPrice ?? p.entryPrice ?? 0) * (p.quantity ?? 0), 0);

    return {
      safe_id: safeId,
      chain,
      cash,
      total_deposited: totalDeposited,
      positions,
      total_value: Math.round((cash + positionValue) * 100) / 100,
    };
  }

  /**
   * Build a portfolio snapshot across all known chains.
   *
   * Mirrors the legacy db-query.js `get-portfolio` (no chain arg) branch
   * (lines 479-497). Iterates `getAllChains()` — NOT just ACTIVE_CHAINS —
   * to match legacy parity (SPEC §P5b plan, risk §6).
   */
  async getPortfolioAllChains(mode: 'real' | 'paper'): Promise<Omit<PortfolioResponseDto, '_mode'>> {
    const safeIdRow = await this.prisma.portfolioMeta.findUnique({ where: { key: 'safe_id' } });
    const safeId = safeIdRow?.value ?? null;

    // Load all open/partial_exit positions (both tables in one query each).
    let allPositions: Array<{
      chain: string;
      currentPrice?: number | null;
      entryPrice: number;
      quantity: number;
      takeProfitLevels: string;
      [key: string]: unknown;
    }>;
    if (mode === 'paper') {
      allPositions = await this.prisma.paperPosition.findMany({
        where: { status: { in: ['open', 'partial_exit'] } },
        orderBy: { createdAt: 'desc' },
      });
    } else {
      allPositions = await this.prisma.position.findMany({
        where: { status: { in: ['open', 'partial_exit'] } },
        orderBy: { createdAt: 'desc' },
      });
    }

    // Load all cash_ meta keys in one query.
    const cashRows = await this.prisma.portfolioMeta.findMany({
      where: { key: { startsWith: 'cash_' } },
    });
    const cashByChain: Record<string, number> = {};
    for (const row of cashRows) {
      const c = row.key.slice('cash_'.length);
      if (c) cashByChain[c] = parseFloat(row.value ?? '0');
    }

    const chains: Record<string, { cash: number; positions: unknown[]; total_value: number }> = {};
    for (const c of getAllChains()) {
      const cPositions = allPositions
        .filter((p) => p.chain === c)
        .map((p) => ({
          ...p,
          take_profit_levels: (() => {
            try {
              return JSON.parse(p.takeProfitLevels) as unknown;
            } catch {
              return [];
            }
          })(),
        }));
      const cCash = cashByChain[c] ?? 0;
      const positionValue = cPositions.reduce(
        (sum, p) =>
          sum +
          ((p as { currentPrice?: number | null }).currentPrice ?? (p as { entryPrice: number }).entryPrice) *
            (p as { quantity: number }).quantity,
        0,
      );
      chains[c] = {
        cash: cCash,
        positions: cPositions,
        total_value: Math.round((cCash + positionValue) * 100) / 100,
      };
    }

    const totalValue = Object.values(chains).reduce((sum, c) => sum + c.total_value, 0);
    return { safe_id: safeId, chains, total_value: Math.round(totalValue * 100) / 100 };
  }

  // ---------------------------------------------------------------------------
  // Trade stats
  // ---------------------------------------------------------------------------

  /**
   * Aggregate trade statistics.
   *
   * Mirrors legacy db-query.js `get-trade-stats` (lines 1447-1498).
   * Uses $queryRaw with Prisma.sql tagged template so the raw result
   * columns are typed explicitly — avoids the silent snake→camelCase
   * null bug (recurring failure pattern, SPEC P5b plan risk §3).
   *
   * The `mode` parameter selects the correct receipts table (paper_receipts
   * for stats when PAPER_MODE — mirrors PAPER_VARIANT routing in legacy).
   *
   * NOTE: SQLite returns bigint for COUNT(*) via $queryRaw. Number() cast is
   * applied explicitly on every numeric field.
   */
  async getTradeStats(
    chain: string | undefined,
    mode: 'real' | 'paper',
  ): Promise<Omit<TradeStatsResponseDto, '_mode'>> {
    // Select the correct table based on mode.
    // Paper mode: receipts table is paper_receipts (matches legacy PAPER_VARIANT routing).
    // Real mode: trades table.
    const table = mode === 'paper' ? 'paper_receipts' : 'trades';

    // Raw aggregate — explicit snake_case column aliases match the result row interface.
    interface AggRow {
      total_trades: bigint | number;
      wins: bigint | number;
      losses: bigint | number;
      avg_win_percent: number | null;
      avg_loss_percent: number | null;
      total_pnl_usd: number | null;
      best_trade_pnl: number | null;
      worst_trade_pnl: number | null;
    }

    let aggRows: AggRow[];
    if (chain) {
      aggRows = await this.prisma.$queryRaw<AggRow[]>(Prisma.sql`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losses,
          ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_percent END), 2) as avg_win_percent,
          ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_percent END), 2) as avg_loss_percent,
          ROUND(SUM(pnl_usd), 2) as total_pnl_usd,
          MAX(pnl_usd) as best_trade_pnl,
          MIN(pnl_usd) as worst_trade_pnl
        FROM ${Prisma.raw(table)} WHERE pnl_usd IS NOT NULL AND chain = ${chain}
      `);
    } else {
      aggRows = await this.prisma.$queryRaw<AggRow[]>(Prisma.sql`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losses,
          ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_percent END), 2) as avg_win_percent,
          ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_percent END), 2) as avg_loss_percent,
          ROUND(SUM(pnl_usd), 2) as total_pnl_usd,
          MAX(pnl_usd) as best_trade_pnl,
          MIN(pnl_usd) as worst_trade_pnl
        FROM ${Prisma.raw(table)} WHERE pnl_usd IS NOT NULL
      `);
    }

    // Explicit per-field extraction — never trust implicit snake→camelCase mapping.
    const agg = aggRows[0] ?? {};
    const totalTrades = Number(agg.total_trades ?? 0);
    const wins = Number(agg.wins ?? 0);
    const losses = Number(agg.losses ?? 0);
    const avgWinPercent = agg.avg_win_percent != null ? Number(agg.avg_win_percent) : null;
    const avgLossPercent = agg.avg_loss_percent != null ? Number(agg.avg_loss_percent) : null;
    const totalPnlUsd = agg.total_pnl_usd != null ? Number(agg.total_pnl_usd) : null;
    const bestTradePnl = agg.best_trade_pnl != null ? Number(agg.best_trade_pnl) : null;
    const worstTradePnl = agg.worst_trade_pnl != null ? Number(agg.worst_trade_pnl) : null;

    // Cash and initial balance — same queries as legacy (lines 1470-1481).
    let cash: number;
    let initialBalance: number;
    if (chain) {
      const cashRow = await this.prisma.portfolioMeta.findUnique({ where: { key: `cash_${chain}` } });
      cash = parseFloat(cashRow?.value ?? '0');
      const depositRow = await this.prisma.portfolioMeta.findUnique({ where: { key: `total_deposited_${chain}` } });
      initialBalance = parseFloat(depositRow?.value ?? '0');
    } else {
      const cashRows2 = await this.prisma.portfolioMeta.findMany({ where: { key: { startsWith: 'cash_' } } });
      cash = cashRows2.reduce((sum, r) => sum + parseFloat(r.value ?? '0'), 0);
      const depositRows = await this.prisma.portfolioMeta.findMany({
        where: { key: { startsWith: 'total_deposited_' } },
      });
      initialBalance = depositRows.reduce((sum, r) => sum + parseFloat(r.value ?? '0'), 0);
    }

    // Open position value — same table selection as legacy (lines 1483-1488).
    let openPositions: Array<{
      valueUsd?: number | null;
      currentPrice?: number | null;
      entryPrice: number;
      quantity: number;
    }>;
    if (mode === 'paper') {
      const rows = chain
        ? await this.prisma.paperPosition.findMany({ where: { status: { in: ['open', 'partial_exit'] }, chain } })
        : await this.prisma.paperPosition.findMany({ where: { status: { in: ['open', 'partial_exit'] } } });
      openPositions = rows;
    } else {
      const rows = chain
        ? await this.prisma.position.findMany({ where: { status: { in: ['open', 'partial_exit'] }, chain } })
        : await this.prisma.position.findMany({ where: { status: { in: ['open', 'partial_exit'] } } });
      openPositions = rows;
    }

    const positionValue = openPositions.reduce(
      (sum, p) => sum + (p.valueUsd ?? (p.currentPrice ?? p.entryPrice) * p.quantity),
      0,
    );
    const totalValue = cash + positionValue;

    const winRate = totalTrades > 0 ? Math.round((wins / totalTrades) * 100) : 0;
    const totalReturnPercent =
      initialBalance > 0 ? Math.round(((totalValue - initialBalance) / initialBalance) * 10000) / 100 : 0;

    return {
      total_trades: totalTrades,
      wins,
      losses,
      avg_win_percent: avgWinPercent,
      avg_loss_percent: avgLossPercent,
      total_pnl_usd: totalPnlUsd,
      best_trade_pnl: bestTradePnl,
      worst_trade_pnl: worstTradePnl,
      win_rate: winRate,
      total_return_percent: totalReturnPercent,
      current_value: Math.round(totalValue * 100) / 100,
      initial_balance: initialBalance,
      ...(chain ? { chain } : {}),
    };
  }
}

// Re-export for type use in DTOs
export type { PortfolioMeta };
