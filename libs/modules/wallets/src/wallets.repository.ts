import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only import from @prisma/client allowed in repository files.
// eslint-disable-next-line no-restricted-imports
import type { TrackedWallet } from '@prisma/client';
import type { AddTrackedWalletDto } from './dto/add-tracked-wallet.dto.js';
import type { ProposeWalletDto } from './dto/propose-wallet.dto.js';
import type { UpdateWalletScoreDto } from './dto/update-wallet-score.dto.js';
import type { TrackedWalletsQueryDto } from './dto/tracked-wallets-query.dto.js';
import type { TrackedWalletResponseDto } from './dto/tracked-wallet-response.dto.js';

/**
 * Wallets repository — the only place Prisma queries for tracked_wallets live.
 *
 * score_breakdown is kept as a raw JSON string (bug-for-bug parity with db-query.js;
 * db-query.js passes JSON.stringify when the value is an object but never auto-parses
 * on read).
 */
@Injectable()
export class WalletsRepository {
  constructor(private readonly prisma: PrismaService) {}

  private mapRow(row: TrackedWallet): TrackedWalletResponseDto {
    return {
      address: row.address,
      chain: row.chain,
      label: row.label ?? null,
      type: row.type ?? null,
      notes: row.notes ?? null,
      status: row.status,
      score: row.score ?? null,
      score_breakdown: row.scoreBreakdown ?? null,
      source_token: row.sourceToken ?? null,
      scored_at: row.scoredAt ?? null,
      score_error: row.scoreError ?? null,
      retry_count: row.retryCount,
      source: row.source ?? null,
      last_checked_at: row.lastCheckedAt ?? null,
      created_at: row.createdAt ?? null,
    };
  }

  /** List wallets with optional filters. */
  async findMany(query: TrackedWalletsQueryDto): Promise<TrackedWalletResponseDto[]> {
    const limit = Math.min(query.limit ?? 100, 500);
    const rows = await this.prisma.trackedWallet.findMany({
      where: {
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.chain ? { chain: query.chain } : {}),
      },
      take: limit,
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.mapRow(r));
  }

  /** Get a single wallet by composite key. */
  async findOne(address: string, chain: string): Promise<TrackedWalletResponseDto> {
    const row = await this.prisma.trackedWallet.findUnique({
      where: { address_chain: { address, chain } },
    });
    if (!row) throw new NotFoundException(`Wallet ${address}/${chain} not found`);
    return this.mapRow(row);
  }

  /**
   * Upsert a wallet (INSERT OR REPLACE semantics — mirrors add-tracked-wallet).
   *
   * If type is provided, status defaults to 'scored'; otherwise 'proposed'.
   */
  async upsertWallet(dto: AddTrackedWalletDto): Promise<TrackedWalletResponseDto> {
    const now = new Date().toISOString();
    const walletStatus = dto.status ?? (dto.type ? 'scored' : 'proposed');
    const scoreBreakdown = dto.score_breakdown
      ? typeof dto.score_breakdown === 'string'
        ? dto.score_breakdown
        : JSON.stringify(dto.score_breakdown)
      : null;

    const row = await this.prisma.trackedWallet.upsert({
      where: { address_chain: { address: dto.address, chain: dto.chain } },
      update: {
        label: dto.label ?? undefined,
        type: dto.type ?? undefined,
        notes: dto.notes ?? undefined,
        status: walletStatus,
        score: dto.score ?? undefined,
        scoreBreakdown: scoreBreakdown ?? undefined,
        sourceToken: dto.source_token ?? undefined,
        source: dto.source ?? undefined,
        retryCount: dto.retry_count ?? undefined,
      },
      create: {
        address: dto.address,
        chain: dto.chain,
        label: dto.label ?? null,
        type: dto.type ?? null,
        notes: dto.notes ?? null,
        status: walletStatus,
        score: dto.score ?? null,
        scoreBreakdown: scoreBreakdown,
        sourceToken: dto.source_token ?? null,
        source: dto.source ?? 'agent',
        retryCount: dto.retry_count ?? 0,
        createdAt: now,
      },
    });
    return this.mapRow(row);
  }

  /**
   * Propose a wallet (INSERT OR IGNORE semantics — mirrors propose-wallet).
   *
   * Returns the existing row if address/chain already exists.
   */
  async proposeWallet(
    dto: ProposeWalletDto,
  ): Promise<{ ok: boolean; address: string; status: string; source: string }> {
    const source = dto.source ?? 'agent';
    const now = new Date().toISOString();

    await this.prisma.trackedWallet.upsert({
      where: { address_chain: { address: dto.address, chain: dto.chain } },
      // On conflict: no-op (INSERT OR IGNORE parity — don't overwrite an existing row)
      update: {},
      create: {
        address: dto.address,
        chain: dto.chain,
        label: dto.label ?? null,
        sourceToken: dto.source_token ?? null,
        source,
        status: 'proposed',
        retryCount: 0,
        createdAt: now,
      },
    });

    return { ok: true, address: dto.address, status: 'proposed', source };
  }

  /**
   * List wallets pending scoring (proposed OR failed with retry_count < 3).
   *
   * Uses Prisma findMany instead of $queryRaw so that Prisma handles the
   * snake_case → camelCase column-name mapping automatically. The previous
   * $queryRaw<TrackedWallet[]> with SELECT * returned physical column names
   * (retry_count, score_breakdown, etc.) from SQLite, but mapRow() accessed
   * camelCase keys (retryCount, scoreBreakdown) — resulting in undefined values
   * for those fields. findMany always returns the Prisma model shape.
   */
  async findUnscored(limit = 5): Promise<TrackedWalletResponseDto[]> {
    const rows = await this.prisma.trackedWallet.findMany({
      where: {
        OR: [{ status: 'proposed' }, { AND: [{ status: 'failed' }, { retryCount: { lt: 3 } }] }],
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Update a wallet's score and related fields (mirrors update-wallet-score).
   *
   * The retry_count increment logic from db-query.js is preserved:
   * retry_count only increments when status = 'failed'.
   */
  async updateScore(address: string, chain: string, dto: UpdateWalletScoreDto): Promise<TrackedWalletResponseDto> {
    const now = new Date().toISOString();
    const newStatus = dto.status ?? 'scored';
    const scoreBreakdown = dto.score_breakdown
      ? typeof dto.score_breakdown === 'string'
        ? dto.score_breakdown
        : JSON.stringify(dto.score_breakdown)
      : null;

    // Mirror the CASE WHEN logic from db-query.js: increment retry_count only on failure
    const existing = await this.prisma.trackedWallet.findUnique({
      where: { address_chain: { address, chain } },
    });
    if (!existing) throw new NotFoundException(`Wallet ${address}/${chain} not found`);

    const row = await this.prisma.trackedWallet.update({
      where: { address_chain: { address, chain } },
      data: {
        score: dto.score ?? null,
        type: dto.type ?? null,
        scoreBreakdown: scoreBreakdown,
        status: newStatus,
        scoredAt: now,
        scoreError: dto.score_error ?? null,
        retryCount: newStatus === 'failed' ? existing.retryCount + 1 : existing.retryCount,
      },
    });
    return this.mapRow(row);
  }

  /**
   * Find the next batch of activity-polling candidates.
   *
   * Returns wallets where `type='smart_money' AND status='scored'`, ordered
   * by `lastCheckedAt ASC NULLS FIRST` (rotation: oldest checked first).
   * Wallets that have never been checked appear first (NULLS FIRST).
   *
   * Mirrors the ORDER BY clause in `scripts/activity-wallets-bg.js:231-238`:
   *   `ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC`
   * which is equivalent to NULLS FIRST ordering in SQLite.
   *
   * Uses Prisma `$queryRaw` because Prisma's `findMany` does not support
   * `NULLS FIRST` in SQLite via the standard `orderBy` API. The query is
   * parameterised and the `limit` argument is validated to an integer before
   * interpolation (defence-in-depth; the caller always passes a literal int).
   */
  async findActivityCandidates(limit: number): Promise<TrackedWalletResponseDto[]> {
    const safeLimit = Math.max(1, Math.trunc(limit));
    // $queryRaw (tagged template — safe, not $queryRawUnsafe): NULLS FIRST ordering requires raw SQL
    // on SQLite because Prisma's orderBy API doesn't support nullsFirst across all SQLite drivers.
    // The limit is validated to a safe integer above.
    const rows = await this.prisma.$queryRaw<TrackedWallet[]>`
      SELECT address, chain, label, type, notes, status, score,
             score_breakdown AS "scoreBreakdown",
             source_token AS "sourceToken",
             scored_at AS "scoredAt",
             score_error AS "scoreError",
             retry_count AS "retryCount",
             source,
             last_checked_at AS "lastCheckedAt",
             created_at AS "createdAt"
      FROM tracked_wallets
      WHERE type = 'smart_money' AND status = 'scored'
      ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC
      LIMIT ${safeLimit}
    `;
    return rows.map((r) => this.mapRow(r));
  }

  /**
   * Update the `last_checked_at` timestamp for a wallet.
   *
   * Called after EVERY wallet processed by ActivityWalletsProcessor, regardless
   * of success or failure, so that the rotation always advances and a
   * permanently-dead wallet doesn't block the queue.
   *
   * Mirrors `updateLastCheckedStmt.run(...)` in `scripts/activity-wallets-bg.js:342`.
   */
  async updateLastChecked(address: string, chain: string, ts: string): Promise<void> {
    await this.prisma.trackedWallet.update({
      where: { address_chain: { address, chain } },
      data: { lastCheckedAt: ts },
    });
  }

  /** Delete a wallet by composite key (mirrors remove-tracked-wallet). */
  async remove(address: string, chain: string): Promise<{ ok: boolean }> {
    const row = await this.prisma.trackedWallet.findUnique({
      where: { address_chain: { address, chain } },
    });
    if (!row) throw new NotFoundException(`Wallet ${address}/${chain} not found`);
    await this.prisma.trackedWallet.delete({
      where: { address_chain: { address, chain } },
    });
    return { ok: true };
  }
}
