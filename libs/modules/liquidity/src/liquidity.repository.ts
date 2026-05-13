import { Injectable } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// eslint-disable-next-line no-restricted-imports
import type { LiquiditySnapshot } from '@prisma/client';
import type { AddLiquiditySnapshotDto } from './dto/add-liquidity-snapshot.dto.js';
import type { LiquidityQueryDto } from './dto/liquidity-query.dto.js';
import type { LiquiditySnapshotResponseDto } from './dto/liquidity-snapshot-response.dto.js';

/**
 * Liquidity repository — the only place Prisma queries for liquidity_snapshots live.
 */
@Injectable()
export class LiquidityRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapRow(row: LiquiditySnapshot): LiquiditySnapshotResponseDto {
    return {
      id: row.id,
      address: row.address,
      chain: row.chain,
      liquidity_usd: row.liquidityUsd,
      checked_at: row.checkedAt ?? null,
    };
  }

  /**
   * List liquidity snapshots, optionally filtered by address/chain.
   *
   * Legacy semantics (db-query.js get-liquidity):
   *   - requires --address AND --chain when in legacy mode
   *   - ordered by checked_at DESC
   *   - default limit 2 per address/chain pair
   */
  async findMany(query: LiquidityQueryDto): Promise<LiquiditySnapshotResponseDto[]> {
    const limit = Math.min(query.limit ?? 2, 100);
    const rows = await this.prisma.liquiditySnapshot.findMany({
      where: {
        ...(query.address ? { address: query.address } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
      },
      take: limit,
      orderBy: { checkedAt: 'desc' },
    });
    return rows.map((r) => this.mapRow(r));
  }

  /** Insert a new liquidity snapshot (mirrors add-liquidity-snapshot). */
  async create(dto: AddLiquiditySnapshotDto): Promise<{ ok: boolean }> {
    const now = new Date().toISOString();
    await this.prisma.liquiditySnapshot.create({
      data: {
        address: dto.address,
        chain: dto.chain,
        liquidityUsd: dto.liquidity_usd,
        checkedAt: now,
      },
    });
    return { ok: true };
  }
}
