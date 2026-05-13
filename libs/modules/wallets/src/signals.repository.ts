import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
import type { SignalsQueryDto } from './dto/signals-query.dto.js';
import type {
  SmartMoneySignalResponseDto,
  SmartMoneySignalGroupedResponseDto,
} from './dto/smart-money-signal-response.dto.js';

/**
 * Allowed chain identifiers — guards against SQL injection when `chain` is
 * interpolated into raw SQL in getSignals().
 *
 * Extend this list as new chains are added to scripts/chains.js.
 */
const ALLOWED_CHAINS = new Set(['base', 'eth', 'solana', 'bsc', 'arbitrum', 'polygon', 'optimism', 'avalanche']);

/**
 * Signals repository — the only place Prisma queries for smart_money_signals live.
 *
 * The grouped (get-smart-money-signals --group-by token) query uses $queryRawUnsafe
 * because Prisma's groupBy API does not support ROUND(AVG(...)) ergonomically.
 * All parameters are validated (regex / enum allowlist) before interpolation.
 */
@Injectable()
export class SignalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate and parse the `since` parameter into a SQLite interval string.
   *
   * @param since - e.g. '35m', '2h', '1d'
   * @returns SQLite datetime modifier string, e.g. '-35 minutes'
   */
  private parseSince(since: string): string {
    // Validated by DTO Matches decorator; double-check here for defence-in-depth.
    const m = since.match(/^(\d+)([mhd])$/);
    if (!m) throw new BadRequestException(`Invalid since format: ${since}`);
    const unit = m[2] === 'm' ? 'minutes' : m[2] === 'h' ? 'hours' : 'days';
    return `-${m[1]} ${unit}`;
  }

  /**
   * Fetch smart-money signals with optional filtering.
   *
   * Mirrors get-smart-money-signals in db-query.js exactly:
   * - ungrouped: SELECT * ordered by created_at DESC
   * - grouped:   SELECT token_address, chain, COUNT, AVG, MIN, MAX aggregates
   */
  async getSignals(
    query: SignalsQueryDto,
  ): Promise<SmartMoneySignalResponseDto[] | SmartMoneySignalGroupedResponseDto[]> {
    const since = query.since ?? '35m';
    const limit = Math.min(query.limit ?? 100, 500);
    const sinceClause = this.parseSince(since);

    // Validate action enum
    if (query.action && query.action !== 'buy' && query.action !== 'sell') {
      throw new BadRequestException('action must be buy or sell');
    }

    // Validate chain allowlist before interpolation
    if (query.chain && !ALLOWED_CHAINS.has(query.chain)) {
      throw new BadRequestException(`Unknown chain: ${query.chain}`);
    }

    // Build WHERE clauses. We use $queryRawUnsafe with parameterised placeholders where
    // possible; the sinceClause string is validated above (regex) so safe to interpolate.
    const whereClauses: string[] = [`created_at > datetime('now', ?)`];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw SQL params array
    const params: any[] = [sinceClause];

    if (query.action) {
      whereClauses.push('action = ?');
      params.push(query.action);
    }

    if (query.chain) {
      whereClauses.push('chain = ?');
      params.push(query.chain);
    }

    if (query.tokens_in_positions) {
      // NOTE: PAPER_MODE is not available in the repository layer; the service passes the
      // appropriate table name. To stay consistent with legacy behaviour we replicate
      // db-query.js's approach of checking PAPER_MODE at query time.
      // Since repositories do not read process.env directly (SPEC §4 #6), we always query
      // the real positions table here. The service layer may override this in future if
      // paper-mode support for signals is required. For P2 scope, the agents that consume
      // signals (Research + Sentinel) operate in real mode.
      whereClauses.push(`(token_address, chain) IN (
        SELECT address, chain FROM positions
        WHERE status IN ('open', 'partial_exit', 'draft', 'pending_exit')
      )`);
    }

    const whereStr = whereClauses.join(' AND ');

    if (query.group_by === 'token') {
      const minWallets = query.min_wallets ?? 0;
      // Use a parameterized HAVING clause so that minWallets is passed as a
      // positional '?' binding rather than interpolated into the SQL string.
      // This is consistent with the '?' placeholder pattern used for the WHERE
      // clauses above, and avoids relying on TypeScript's number type to guarantee
      // injection safety for this value.
      const havingClause = minWallets > 0 ? 'HAVING n_wallets >= ?' : '';
      const havingParams = minWallets > 0 ? [minWallets] : [];

      const sql = `
        SELECT token_address, chain, token_symbol,
          COUNT(*) AS signal_count,
          COUNT(DISTINCT wallet_address) AS n_wallets,
          ROUND(AVG(wallet_score), 1) AS avg_score,
          SUM(CASE WHEN action='buy' THEN 1 ELSE 0 END) AS buys,
          SUM(CASE WHEN action='sell' THEN 1 ELSE 0 END) AS sells,
          MIN(tx_timestamp) AS first_seen,
          MAX(tx_timestamp) AS last_seen
        FROM smart_money_signals
        WHERE ${whereStr}
        GROUP BY token_address, chain
        ${havingClause}
        ORDER BY n_wallets DESC, signal_count DESC
        LIMIT ?
      `;
      const rows = await this.prisma.$queryRawUnsafe<SmartMoneySignalGroupedResponseDto[]>(
        sql,
        ...params,
        ...havingParams,
        limit,
      );
      return rows;
    } else {
      const sql = `
        SELECT * FROM smart_money_signals
        WHERE ${whereStr}
        ORDER BY created_at DESC
        LIMIT ?
      `;
      const rows = await this.prisma.$queryRawUnsafe<SmartMoneySignalResponseDto[]>(sql, ...params, limit);
      return rows;
    }
  }
}
