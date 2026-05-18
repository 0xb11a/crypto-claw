import type { PortfolioRules } from '@cclaw/chain';

/**
 * Response DTO for GET /v1/system/chains/:chain.
 *
 * Shape mirrors the legacy db-query.js `get-chain-config` output
 * (lines 559-571). The `rules` field is the merged PortfolioRules
 * object (global defaults + per-chain overrides).
 *
 * Note: `chainId` is null for Solana (SolanaChain.chainId === null).
 */
export class ChainConfigResponseDto {
  name!: string;
  type!: 'evm' | 'solana';
  chainId!: string | null;
  dex!: '1inch' | 'jupiter';
  nativeToken!: { symbol: string; decimals: number };
  wrappedNativeToken!: { symbol: string; address: string; decimals: number };
  cashToken!: { symbol: string; address: string; decimals: number };
  baseTierTokens!: { symbol: string; address: string; decimals: number }[];
  stablecoins!: string[];
  rules!: PortfolioRules;
}
