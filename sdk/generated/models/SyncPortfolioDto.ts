/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SyncPortfolioDto = {
  /**
   * Chain to reconcile (e.g. base, solana, ethereum)
   */
  chain: string;
  /**
   * Trigger reason for this sync. Defaults to "manual".
   */
  trigger?: 'periodic' | 'post_trade' | 'manual';
};
