/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AddWatchlistDto = {
  /**
   * Token contract address
   */
  address: string;
  /**
   * Analysis score (0-100)
   */
  analysis_score?: number;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Current price in USD
   */
  current_price?: number;
  /**
   * ISO8601 expiry timestamp
   */
  expires_at?: string;
  /**
   * Unique ID for this watchlist entry
   */
  id: string;
  narrative?: string;
  /**
   * Reason for adding to watchlist
   */
  reason?: string;
  /**
   * Risk score (0-100)
   */
  risk_score?: number;
  /**
   * Status (default: watching)
   */
  status?: 'watching' | 'entry_hit' | 'expired' | 'removed';
  /**
   * Token symbol
   */
  symbol: string;
  /**
   * Target entry price in USD
   */
  target_entry?: number;
};
