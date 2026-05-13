/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AppendResearchLogDto = {
  alerts_processed?: number;
  /**
   * Heartbeat check type (e.g. token_scan, smart_money)
   */
  check_type: string;
  status?: 'ok' | 'warn' | 'error';
  summary?: string;
  tokens_analyzed?: number;
  tokens_scanned?: number;
  trades_proposed?: number;
  watchlist_hits?: number;
};
