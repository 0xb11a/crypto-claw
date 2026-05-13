/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ProposeWalletDto = {
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
  /**
   * Source of proposal (default: agent)
   */
  source?: string;
  /**
   * Token address that led to this wallet being proposed
   */
  source_token?: string;
};
