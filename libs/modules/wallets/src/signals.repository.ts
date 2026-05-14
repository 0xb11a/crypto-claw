import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '@cclaw/prisma';
import type { SignalsQueryDto } from './dto/signals-query.dto.js';
import type {
  SmartMoneySignalResponseDto,
  SmartMoneySignalGroupedResponseDto,
} from './dto/smart-money-signal-response.dto.js';
import type { CreateSignalInput } from './jobs/swap-extraction.js';

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
 *
 * The ungrouped path uses Prisma findMany for type safety; the tokens_in_positions
 * subquery path still requires $queryRawUnsafe due to the JOIN subquery on positions.
 */
@Injectable()
export class SignalsRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate and parse the `since` parameter into an ISO-8601 string for Prisma gte filters.
   *
   * The `smart_money_signals.created_at` column is typed as `String?` in the Prisma schema
   * (matching the legacy SQLite TEXT storage format). Prisma's `findMany` requires that the
   * `gte` filter value matches the declared field type — passing a JavaScript `Date` object
   * against a `String?` field causes a runtime type mismatch. We return an ISO string so
   * Prisma performs a string-to-string lexicographic comparison, which is correct for
   * ISO-8601 timestamps stored in UTC.
   *
   * @param since - e.g. '35m', '2h', '1d'
   * @returns ISO-8601 string representing the start of the time window
   */
  private parseSinceDate(since: string): string {
    // Validated by DTO Matches decorator; double-check here for defence-in-depth.
    const m = since.match(/^(\d+)([mhd])$/);
    if (!m) throw new BadRequestException(`Invalid since format: ${since}`);
    const n = parseInt(m[1]!, 10);
    const unit = m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    return new Date(Date.now() - n * unit).toISOString();
  }

  /**
   * Validate and parse the `since` parameter into a SQLite interval string.
   * Used only for $queryRawUnsafe paths (grouped, tokens_in_positions).
   *
   * @param since - e.g. '35m', '2h', '1d'
   * @returns SQLite datetime modifier string, e.g. '-35 minutes'
   */
  private parseSinceSql(since: string): string {
    const m = since.match(/^(\d+)([mhd])$/);
    if (!m) throw new BadRequestException(`Invalid since format: ${since}`);
    const unit = m[2] === 'm' ? 'minutes' : m[2] === 'h' ? 'hours' : 'days';
    return `-${m[1]} ${unit}`;
  }

  /**
   * Fetch smart-money signals with optional filtering.
   *
   * Mirrors get-smart-money-signals in db-query.js exactly:
   * - ungrouped (default): Prisma findMany with typed filters
   * - ungrouped + tokens_in_positions: $queryRawUnsafe (SQL subquery required)
   * - grouped:   SELECT token_address, chain, COUNT, AVG, MIN, MAX aggregates
   */
  async getSignals(
    query: SignalsQueryDto,
  ): Promise<SmartMoneySignalResponseDto[] | SmartMoneySignalGroupedResponseDto[]> {
    const since = query.since ?? '35m';
    const limit = Math.min(query.limit ?? 100, 500);

    // Validate action enum
    if (query.action && query.action !== 'buy' && query.action !== 'sell') {
      throw new BadRequestException('action must be buy or sell');
    }

    // Validate chain allowlist before any interpolation
    if (query.chain && !ALLOWED_CHAINS.has(query.chain)) {
      throw new BadRequestException(`Unknown chain: ${query.chain}`);
    }

    if (query.group_by === 'token') {
      // Grouped path: requires ROUND(AVG(...)) — $queryRawUnsafe is necessary
      // (ADR-0020: Prisma groupBy does not support ROUND(AVG()) ergonomically).
      const sinceClause = this.parseSinceSql(since);
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
        whereClauses.push(`(token_address, chain) IN (
          SELECT address, chain FROM positions
          WHERE status IN ('open', 'partial_exit', 'draft', 'pending_exit')
        )`);
      }

      const whereStr = whereClauses.join(' AND ');
      const minWallets = query.min_wallets ?? 0;
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

      // eslint-disable-next-line no-restricted-syntax -- ROUND(AVG()) requires raw SQL; all params validated above (ADR-0020)
      const rows = await this.prisma.$queryRawUnsafe<SmartMoneySignalGroupedResponseDto[]>(
        sql,
        ...params,
        ...havingParams,
        limit,
      );
      return rows;
    }

    if (query.tokens_in_positions) {
      // tokens_in_positions requires a SQL subquery JOIN on positions table —
      // $queryRawUnsafe is necessary (Prisma findMany cannot express IN subqueries).
      // (ADR-0020: allowed with inline comment; all params are validated above.)
      const sinceClause = this.parseSinceSql(since);
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
      // NOTE: PAPER_MODE is not available in the repository layer; always query
      // the real positions table (consistent with legacy behaviour; see original comment).
      whereClauses.push(`(token_address, chain) IN (
        SELECT address, chain FROM positions
        WHERE status IN ('open', 'partial_exit', 'draft', 'pending_exit')
      )`);

      const whereStr = whereClauses.join(' AND ');
      const sql = `
        SELECT * FROM smart_money_signals
        WHERE ${whereStr}
        ORDER BY created_at DESC
        LIMIT ?
      `;

      // eslint-disable-next-line no-restricted-syntax -- IN subquery on positions requires raw SQL; all params validated above (ADR-0020)
      const rows = await this.prisma.$queryRawUnsafe<SmartMoneySignalResponseDto[]>(sql, ...params, limit);
      return rows;
    }

    // Ungrouped path without tokens_in_positions: use Prisma findMany for type safety.
    const sinceDate = this.parseSinceDate(since);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Prisma SmartMoneySignal type not exported
    const whereClause: Record<string, any> = {
      createdAt: { gte: sinceDate },
    };
    if (query.action) whereClause['action'] = query.action;
    if (query.chain) whereClause['chain'] = query.chain;

    const rows = await this.prisma.smartMoneySignal.findMany({
      where: whereClause,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });

    // Map camelCase Prisma fields to snake_case response shape (parity with db-query.js)
    return rows.map((r) => ({
      id: r.id,
      tx_hash: r.txHash,
      chain: r.chain,
      wallet_address: r.walletAddress,
      wallet_score: r.walletScore,
      wallet_label: r.walletLabel,
      action: r.action,
      token_address: r.tokenAddress,
      token_symbol: r.tokenSymbol,
      counter_token_address: r.counterTokenAddress,
      counter_token_symbol: r.counterTokenSymbol,
      amount_token: r.amountToken,
      tx_timestamp: r.txTimestamp,
      created_at: r.createdAt,
    })) as SmartMoneySignalResponseDto[];
  }

  /**
   * Insert a swap signal, ignoring duplicates (INSERT OR IGNORE parity).
   *
   * Uses Prisma `upsert` keyed on the `@@unique([txHash, walletAddress, action,
   * tokenAddress])` constraint. When the unique constraint fires, the `update`
   * block is a no-op (empty object), so the existing row is left unchanged —
   * this gives INSERT OR IGNORE semantics.
   *
   * Returns `{ inserted: true }` when a new row was created, or
   * `{ inserted: false }` when the unique constraint prevented insertion.
   *
   * Note: Prisma's `upsert` does not expose whether the operation was a
   * create or update directly, so we compare the `createdAt` field: a just-created
   * row will have a `createdAt` value within the last few milliseconds of `now`.
   * We use a 1-second tolerance to guard against tiny clock-resolution differences.
   *
   * @param input - Signal data from `extractEvmSwaps` or `extractSolanaSwaps`.
   * @param walletAddress - Address of the tracked wallet that triggered this signal.
   * @param walletScore - Score of the wallet (may be null).
   * @param walletLabel - Label of the wallet (may be null).
   * @param chain - Chain identifier (e.g. 'base', 'solana').
   */
  async insertSignal(
    input: CreateSignalInput,
    walletAddress: string,
    walletScore: number | null,
    walletLabel: string | null,
    chain: string,
  ): Promise<{ inserted: boolean }> {
    const now = new Date().toISOString();
    const result = await this.prisma.smartMoneySignal.upsert({
      where: {
        txHash_walletAddress_action_tokenAddress: {
          txHash: input.tx_hash,
          walletAddress,
          action: input.action,
          tokenAddress: input.token_address,
        },
      },
      // On conflict: no-op (INSERT OR IGNORE semantics — don't overwrite existing rows)
      update: {},
      create: {
        txHash: input.tx_hash,
        chain,
        walletAddress,
        walletScore,
        walletLabel,
        action: input.action,
        tokenAddress: input.token_address,
        tokenSymbol: input.token_symbol,
        counterTokenAddress: input.counter_token_address,
        counterTokenSymbol: input.counter_token_symbol,
        amountToken: input.amount_token,
        txTimestamp: input.tx_timestamp,
        createdAt: now,
      },
    });

    // Determine if this was a create or a conflict hit.
    // A conflict-hit row will have an older `createdAt` than `now`.
    // Allow 1 second tolerance for clock resolution.
    const createdMs = result.createdAt ? new Date(result.createdAt).getTime() : 0;
    const inserted = Date.now() - createdMs < 1_000;

    return { inserted };
  }

  /**
   * Delete signals older than `hours` hours.
   *
   * Used by ActivityWalletsProcessor at the start of each cycle to enforce
   * the 24-hour retention window. Mirrors the DELETE in
   * `scripts/activity-wallets-bg.js:224-226`.
   *
   * Returns the number of deleted rows.
   */
  async pruneOlderThan(hours: number): Promise<{ deleted: number }> {
    const cutoff = new Date(Date.now() - hours * 3_600_000).toISOString();
    const result = await this.prisma.smartMoneySignal.deleteMany({
      where: { createdAt: { lt: cutoff } },
    });
    return { deleted: result.count };
  }
}
