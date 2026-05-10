import type { PositionStatus } from './position-list-query.dto.js';
/** Request body for PATCH /v1/positions/:id. All fields optional. */
export declare class UpdatePositionDto {
  current_price?: number;
  quantity?: number;
  value_usd?: number;
  stop_loss?: number;
  take_profit_levels?: number[];
  status?: PositionStatus;
  notes?: string;
  narrative?: string;
  trailing_stop_pct?: number;
  max_price_since_entry?: number;
  tp_levels_hit?: number[];
  onchain_balance?: number;
  last_synced_at?: string;
}
//# sourceMappingURL=update-position.dto.d.ts.map
