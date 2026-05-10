export declare const POSITION_TIERS: readonly ['base', 'conviction', 'moonshot'];
export type PositionTier = (typeof POSITION_TIERS)[number];
/**
 * Request body for POST /v1/positions.
 *
 * @note take_profit_levels is validated as an array of numbers here;
 * the repository layer serialises it to a JSON string before writing to SQLite
 * to maintain parity with the legacy db-query.js behaviour (OPEN-5).
 */
export declare class CreatePositionDto {
  symbol: string;
  name?: string;
  address: string;
  chain: string;
  tier: PositionTier;
  entry_price: number;
  quantity: number;
  stop_loss: number;
  take_profit_levels: number[];
  entry_date?: string;
  narrative?: string;
  notes?: string;
  mode?: 'real' | 'paper';
}
//# sourceMappingURL=create-position.dto.d.ts.map
