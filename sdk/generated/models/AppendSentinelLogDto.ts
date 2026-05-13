/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AppendSentinelLogDto = {
  alerts_generated?: number;
  /**
   * Heartbeat check type (e.g. price_check, liquidity_check)
   */
  check_type: string;
  positions_checked?: number;
  sells_executed?: number;
  status?: 'ok' | 'warn' | 'error';
  summary?: string;
};
