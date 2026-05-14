import { Injectable } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only import from @prisma/client — allowed only in repository files.
// eslint-disable-next-line no-restricted-imports
import type { PortfolioMeta, PortfolioSync } from '@prisma/client';
import type { SetMetaDto } from './dto/set-meta.dto.js';
import type { MetaResponseDto } from './dto/meta-response.dto.js';
import type { SetCashDto } from './dto/set-cash.dto.js';
import type { CashByChainDto } from './dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from './dto/cash-breakdown.dto.js';
import type { GasResponseDto } from './dto/gas-query.dto.js';
import type { SyncStatusQueryDto } from './dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from './dto/portfolio-sync-response.dto.js';

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
    const parsed = JSON.parse(row.value) as Record<string, unknown>;
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
}

// Re-export for type use in DTOs
export type { PortfolioMeta };
