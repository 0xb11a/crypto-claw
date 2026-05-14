/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CacheAnalysisDto = {
  /**
   * Token contract address
   */
  address: string;
  /**
   * Analysis score (0-100)
   */
  analysis_score?: number;
  /**
   * Chain identifier (base, solana, etc.)
   */
  chain: string;
  /**
   * Analysis reasoning text
   */
  reasoning?: string;
  /**
   * Risk score (0-100)
   */
  risk_score?: number;
  /**
   * Token symbol
   */
  symbol?: string;
  /**
   * Tier: base | conviction | moonshot
   */
  tier?: string;
  /**
   * Cache TTL in hours (default: 24)
   */
  ttl_hours?: number;
  /**
   * Verdict: buy | hold | avoid | skip | analyze
   */
  verdict: string;
};
