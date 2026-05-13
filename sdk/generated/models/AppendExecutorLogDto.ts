/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AppendExecutorLogDto = {
  buy_orders_processed?: number;
  fail_count?: number;
  pending_checked?: number;
  queued_count?: number;
  sell_orders_processed?: number;
  status?: 'ok' | 'warn' | 'error';
  success_count?: number;
  summary?: string;
};
