/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AddTrackedWalletDto = {
  /**
   * Wallet address
   */
  address: string;
  /**
   * Chain identifier (e.g. base, solana, eth)
   */
  chain: string;
  /**
   * Human-readable label
   */
  label?: string;
  notes?: string;
  retry_count?: number;
  score?: number;
  score_breakdown?: Record<string, any>;
  source?: string;
  source_token?: string;
  /**
   * Override status (default derived from type)
   */
  status?: string;
  type?: string;
};
