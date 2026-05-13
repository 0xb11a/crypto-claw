import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// eslint-disable-next-line no-restricted-imports
import type { Watchlist } from '@prisma/client';
import type { AddWatchlistDto } from './dto/add-watchlist.dto.js';
import type { UpdateWatchlistDto } from './dto/update-watchlist.dto.js';
import type { WatchlistQueryDto } from './dto/watchlist-query.dto.js';
import type { WatchlistResponseDto } from './dto/watchlist-response.dto.js';

/**
 * Watchlist repository — the only place Prisma queries for the watchlist table live.
 *
 * Soft-delete via status='removed' (mirrors remove-from-watchlist in db-query.js).
 */
@Injectable()
export class WatchlistRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapRow(row: Watchlist): WatchlistResponseDto {
    return {
      id: row.id,
      symbol: row.symbol,
      address: row.address,
      chain: row.chain,
      target_entry: row.targetEntry ?? null,
      current_price: row.currentPrice ?? null,
      analysis_score: row.analysisScore ?? null,
      risk_score: row.riskScore ?? null,
      narrative: row.narrative ?? null,
      reason: row.reason ?? null,
      expires_at: row.expiresAt ?? null,
      status: row.status,
      created_at: row.createdAt ?? null,
      updated_at: row.updatedAt ?? null,
    };
  }

  /**
   * List watchlist entries.
   *
   * Legacy semantics:
   *   --active (get-watchlist --active) → WHERE status='watching'
   *   default                           → all rows ordered by created_at DESC
   *
   * New API: ?status=watching | entry_hit | expired | removed | all (or omit).
   */
  async findMany(query: WatchlistQueryDto): Promise<WatchlistResponseDto[]> {
    const where = query.status && query.status !== 'all' ? { status: query.status } : undefined;
    const rows = await this.prisma.watchlist.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapRow(r));
  }

  /** Get a single watchlist entry by ID. */
  async findById(id: string): Promise<WatchlistResponseDto> {
    const row = await this.prisma.watchlist.findUnique({ where: { id } });
    if (!row) throw new NotFoundException(`Watchlist entry ${id} not found`);
    return this.mapRow(row);
  }

  /** Insert a new watchlist entry (mirrors add-to-watchlist). */
  async create(dto: AddWatchlistDto): Promise<WatchlistResponseDto> {
    const now = new Date().toISOString();
    const row = await this.prisma.watchlist.create({
      data: {
        id: dto.id,
        symbol: dto.symbol,
        address: dto.address,
        chain: dto.chain,
        targetEntry: dto.target_entry ?? null,
        currentPrice: dto.current_price ?? null,
        analysisScore: dto.analysis_score ?? null,
        riskScore: dto.risk_score ?? null,
        narrative: dto.narrative ?? null,
        reason: dto.reason ?? null,
        expiresAt: dto.expires_at ?? null,
        status: dto.status ?? 'watching',
        createdAt: now,
        updatedAt: now,
      },
    });
    return this.mapRow(row);
  }

  /**
   * Update a watchlist entry.
   *
   * Only fields present in ALLOWED_FIELDS (matching db-query.js update-watchlist
   * allowed set) are written. Also updates updated_at timestamp.
   */
  async update(id: string, dto: UpdateWatchlistDto): Promise<WatchlistResponseDto> {
    // Verify existence first to return a clean 404
    const existing = await this.prisma.watchlist.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Watchlist entry ${id} not found`);

    const now = new Date().toISOString();
    const row = await this.prisma.watchlist.update({
      where: { id },
      data: {
        ...(dto.symbol !== undefined ? { symbol: dto.symbol } : {}),
        ...(dto.address !== undefined ? { address: dto.address } : {}),
        ...(dto.chain !== undefined ? { chain: dto.chain } : {}),
        ...(dto.target_entry !== undefined ? { targetEntry: dto.target_entry } : {}),
        ...(dto.current_price !== undefined ? { currentPrice: dto.current_price } : {}),
        ...(dto.analysis_score !== undefined ? { analysisScore: dto.analysis_score } : {}),
        ...(dto.risk_score !== undefined ? { riskScore: dto.risk_score } : {}),
        ...(dto.narrative !== undefined ? { narrative: dto.narrative } : {}),
        ...(dto.reason !== undefined ? { reason: dto.reason } : {}),
        ...(dto.expires_at !== undefined ? { expiresAt: dto.expires_at } : {}),
        ...(dto.status !== undefined ? { status: dto.status } : {}),
        updatedAt: now,
      },
    });
    return this.mapRow(row);
  }

  /**
   * Soft-delete — sets status='removed' (mirrors remove-from-watchlist in db-query.js).
   */
  async softDelete(id: string): Promise<{ ok: boolean; id: string }> {
    const existing = await this.prisma.watchlist.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException(`Watchlist entry ${id} not found`);

    const now = new Date().toISOString();
    await this.prisma.watchlist.update({
      where: { id },
      data: { status: 'removed', updatedAt: now },
    });
    return { ok: true, id };
  }
}
