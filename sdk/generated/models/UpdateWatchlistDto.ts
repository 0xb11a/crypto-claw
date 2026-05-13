/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type UpdateWatchlistDto = {
  address?: string;
  analysis_score?: number;
  chain?: string;
  current_price?: number;
  expires_at?: string;
  narrative?: string;
  reason?: string;
  risk_score?: number;
  status?: 'watching' | 'entry_hit' | 'expired' | 'removed';
  symbol?: string;
  target_entry?: number;
};
