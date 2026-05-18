/**
 * Response DTO for GET /v1/system/trade-stats.
 *
 * Shape mirrors the legacy db-query.js `get-trade-stats` handler
 * (lines 1447-1498) with the same field names. Null values appear
 * when there are no trades (AVG of an empty set returns null in SQLite).
 *
 * The snake→camelCase regression note: this DTO uses snake_case to match
 * the exact JSON field names the legacy script produced. The repository
 * layer explicitly maps every $queryRaw column to avoid the silent-null
 * bug (ADR-0020, recurring failure pattern §B).
 */
export class TradeStatsResponseDto {
  /** Total number of closed trades with pnl_usd populated. */
  total_trades!: number;

  /** Number of trades with pnl_usd > 0. */
  wins!: number;

  /** Number of trades with pnl_usd <= 0. */
  losses!: number;

  /**
   * Average pnl_percent for winning trades.
   * Null when there are no winning trades.
   */
  avg_win_percent!: number | null;

  /**
   * Average pnl_percent for losing trades (≤ 0).
   * Null when there are no losing trades.
   */
  avg_loss_percent!: number | null;

  /** Sum of all pnl_usd values, rounded to 2 dp. */
  total_pnl_usd!: number | null;

  /** Largest pnl_usd value (best single trade). */
  best_trade_pnl!: number | null;

  /** Smallest pnl_usd value (worst single trade). */
  worst_trade_pnl!: number | null;

  /** win_rate = wins / total_trades * 100, rounded to integer. 0 when no trades. */
  win_rate!: number;

  /** total_return_percent = (current_value - initial_balance) / initial_balance * 100. */
  total_return_percent!: number;

  /** Current portfolio value: cash + open position value. */
  current_value!: number;

  /** Total deposited capital (sum of total_deposited_<chain> meta keys). */
  initial_balance!: number;

  /** Present when ?chain=X was supplied. */
  chain?: string;

  _mode!: 'real' | 'paper';
}
