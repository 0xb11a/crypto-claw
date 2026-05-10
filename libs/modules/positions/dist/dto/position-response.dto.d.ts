/**
 * Response shape for a single position.
 *
 * JSON-string columns (take_profit_levels, tp_levels_hit) are parsed
 * by the repository layer and returned as typed arrays here.
 */
export declare class PositionResponseDto {
  id: string;
  symbol: string;
  name?: string | null;
  address: string;
  chain: string;
  tier: string;
  entry_price: number;
  current_price?: number | null;
  quantity: number;
  value_usd?: number | null;
  percent_of_portfolio?: number | null;
  entry_date: string;
  stop_loss: number;
  /** Parsed take-profit levels array. */
  take_profit_levels: number[];
  narrative?: string | null;
  status: string;
  notes?: string | null;
  onchain_balance?: number | null;
  last_synced_at?: string | null;
  exit_price?: number | null;
  exit_date?: string | null;
  pnl_percent?: number | null;
  pnl_usd?: number | null;
  exit_reason?: string | null;
  max_price_since_entry?: number | null;
  trailing_stop_pct?: number | null;
  trailing_stop_active: number;
  /** Parsed TP levels hit array. */
  tp_levels_hit: number[];
  created_at?: string | null;
  updated_at?: string | null;
  /** Whether this is a paper position. */
  mode: 'real' | 'paper';
}
/** Paginated list response. */
export declare class PositionListResponseDto {
  data: PositionResponseDto[];
  pagination: {
    total: number;
    limit: number;
    cursor?: string;
    hasMore: boolean;
  };
}
//# sourceMappingURL=position-response.dto.d.ts.map
