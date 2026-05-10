/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdatePositionDto = {
  /**
   * Updated current price
   */
  current_price?: number;
  /**
   * Timestamp of last on-chain sync
   */
  last_synced_at?: string;
  /**
   * Max price observed since entry (for trailing stop)
   */
  max_price_since_entry?: number;
  narrative?: string;
  notes?: string;
  /**
   * On-chain balance (synced from chain)
   */
  onchain_balance?: number;
  /**
   * Updated quantity
   */
  quantity?: number;
  status?: 'open' | 'partial_exit' | 'closed' | 'pending_analysis' | 'draft' | 'pending_exit';
  /**
   * Updated stop-loss price
   */
  stop_loss?: number;
  /**
   * Updated take-profit levels (array of numbers)
   */
  take_profit_levels?: Array<number>;
  /**
   * TP levels already hit (JSON array of booleans/indices)
   */
  tp_levels_hit?: Array<number>;
  /**
   * Trailing stop percentage (0–100)
   */
  trailing_stop_pct?: number;
  /**
   * Updated value in USD
   */
  value_usd?: number;
};
