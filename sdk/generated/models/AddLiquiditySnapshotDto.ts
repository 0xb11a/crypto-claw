/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type AddLiquiditySnapshotDto = {
  /**
   * Token or pool contract address
   */
  address: string;
  /**
   * Chain identifier (e.g. base, solana, eth)
   */
  chain: string;
  /**
   * Liquidity in USD; must be >= 0
   */
  liquidity_usd: number;
};
