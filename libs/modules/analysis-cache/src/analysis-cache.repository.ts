import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
// Type-only import from @prisma/client — allowed only in repository files.
// eslint-disable-next-line no-restricted-imports
import type { AnalysisCache } from '@prisma/client';
import type { CacheAnalysisDto } from './dto/cache-analysis.dto.js';
import type { AnalysisCacheQueryDto } from './dto/analysis-cache-query.dto.js';
import type { CheckTokenStatusQueryDto } from './dto/check-token-status-query.dto.js';
import type { AnalysisCacheResponseDto } from './dto/analysis-cache-response.dto.js';

/**
 * Analysis cache repository — the only place Prisma queries for analysis_cache live.
 *
 * Parity notes:
 * - expires_at is set via $queryRawUnsafe using SQLite's datetime('now', '+N hours')
 *   to produce "YYYY-MM-DD HH:MM:SS" format (not ISO-Z), matching the legacy
 *   db-query.js cache-analysis command. This is the ONLY safe way to preserve format
 *   parity: Prisma's create() would use JS Date → ISO-Z; $queryRawUnsafe delegates
 *   the format to SQLite.
 * - created_at is also set by SQLite DEFAULT (datetime('now')) via the omit-on-create
 *   pattern used throughout P2 repositories.
 * - Non-expired filter uses SQLite's datetime('now') comparison, not JS Date arithmetic.
 */
@Injectable()
export class AnalysisCacheRepository {
  constructor(private readonly prisma: PrismaService) {}

  private map(row: AnalysisCache): AnalysisCacheResponseDto {
    // $queryRawUnsafe returns SQLite column names (snake_case) even though the
    // TypeScript type annotation uses the Prisma model (camelCase). Columns with
    // @map() in the schema — analysis_score, risk_score, expires_at, created_at —
    // must be read via both camelCase (Prisma findUnique path) and snake_case (raw
    // query path). The cast is safe: we own both SELECT lists.
    const raw = row as unknown as Record<string, unknown>;
    return {
      address: row.address,
      chain: row.chain,
      symbol: row.symbol ?? null,
      analysis_score: row.analysisScore ?? (raw['analysis_score'] as number | null | undefined) ?? null,
      risk_score: row.riskScore ?? (raw['risk_score'] as number | null | undefined) ?? null,
      verdict: row.verdict,
      tier: row.tier ?? null,
      reasoning: row.reasoning ?? null,
      // expires_at: row.expiresAt is undefined on raw query results; fall back to
      // raw['expires_at'] (snake_case key) so the field is always present.
      expires_at: (row.expiresAt ?? (raw['expires_at'] as string | undefined)) as string,
      created_at: row.createdAt ?? (raw['created_at'] as string | null | undefined) ?? null,
    };
  }

  /**
   * Upsert a cache entry.
   *
   * expires_at is set via raw SQL: datetime('now', '+N hours') — preserves
   * SQLite TEXT "YYYY-MM-DD HH:MM:SS" format for parity with db-query.js.
   * created_at is deliberately omitted on upsert so SQLite DEFAULT fires on insert
   * and retains the existing value on conflict-update via the excluded alias.
   */
  async upsert(dto: CacheAnalysisDto): Promise<AnalysisCacheResponseDto> {
    const ttlHours = dto.ttl_hours ?? 24;
    // Raw upsert to preserve SQLite datetime() format for expires_at.
    // $queryRawUnsafe is necessary because Prisma cannot express
    // datetime('now', '+N hours') in its type-safe API.
    await this.prisma.$queryRawUnsafe<unknown[]>(
      `INSERT INTO analysis_cache
         (address, chain, symbol, analysis_score, risk_score, verdict, tier, reasoning, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
       ON CONFLICT(address, chain) DO UPDATE SET
         symbol = excluded.symbol,
         analysis_score = excluded.analysis_score,
         risk_score = excluded.risk_score,
         verdict = excluded.verdict,
         tier = excluded.tier,
         reasoning = excluded.reasoning,
         expires_at = excluded.expires_at,
         created_at = datetime('now')`,
      dto.address,
      dto.chain,
      dto.symbol ?? null,
      dto.analysis_score ?? null,
      dto.risk_score ?? null,
      dto.verdict,
      dto.tier ?? null,
      dto.reasoning ?? null,
      String(ttlHours),
    );
    const row = await this.prisma.analysisCache.findUnique({
      where: { address_chain: { address: dto.address, chain: dto.chain } },
    });
    if (!row) throw new NotFoundException('Analysis cache entry not found after upsert');
    return this.map(row);
  }

  /**
   * List all non-expired cache entries.
   *
   * Filter uses SQLite datetime('now') to stay in sync with expires_at format.
   */
  async findNonExpired(query: AnalysisCacheQueryDto): Promise<AnalysisCacheResponseDto[]> {
    const limit = Math.min(query.limit ?? 50, 500);
    // $queryRawUnsafe required to use datetime('now') comparison (SQLite TEXT).
    const rows = await this.prisma.$queryRawUnsafe<AnalysisCache[]>(
      `SELECT address, chain, symbol, analysis_score, risk_score, verdict, tier, reasoning, expires_at, created_at
       FROM analysis_cache
       WHERE expires_at > datetime('now')
       ORDER BY created_at DESC
       LIMIT ?`,
      limit,
    );
    return rows.map((r) => this.map(r));
  }

  /**
   * Check token status — single-token cache lookup (non-expired only).
   */
  async findByAddressChain(query: CheckTokenStatusQueryDto): Promise<AnalysisCacheResponseDto | null> {
    const rows = await this.prisma.$queryRawUnsafe<AnalysisCache[]>(
      `SELECT address, chain, symbol, analysis_score, risk_score, verdict, tier, reasoning, expires_at, created_at
       FROM analysis_cache
       WHERE address = ? AND chain = ? AND expires_at > datetime('now')
       LIMIT 1`,
      query.address,
      query.chain,
    );
    return rows.length > 0 ? this.map(rows[0]!) : null;
  }

  /**
   * Delete all expired entries.
   *
   * Uses $executeRawUnsafe because Prisma's deleteMany cannot express SQLite
   * datetime() comparison on TEXT fields. Returns the number of deleted rows.
   */
  async deleteExpiredBatch(): Promise<number> {
    const changed = await this.prisma.$executeRawUnsafe(
      `DELETE FROM analysis_cache WHERE expires_at <= datetime('now')`,
    );
    return changed;
  }
}
