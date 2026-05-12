/**
 * chains.ts — Centralized chain configuration (TypeScript port of scripts/chains.js).
 *
 * This file is the TypeScript parallel of `scripts/chains.js`. Values are
 * copied verbatim; DO NOT add new chains or change addresses here without
 * updating `scripts/chains.js` too.
 *
 * OPERATOR NOTE: when adding a chain, update BOTH files. This file serves
 * the new NestJS service (apps/api, apps/worker, apps/executor); the JS
 * file continues to serve the legacy `scripts/` CLI layer during the rewrite
 * window. They are deleted together in P5.
 *
 * @see scripts/chains.js (source of truth)
 * @see SPEC §6, §7 (chain module)
 */

// ---------------------------------------------------------------------------
// RPC hostname allowlists (PR 2.8)
//
// Two match modes per chain:
//   - exact: full hostname match
//   - suffix: domain-suffix match (covers per-API-key subdomains)
// ---------------------------------------------------------------------------

/** RPC URL allowlist shape. */
export interface RpcAllowlist {
  exact: string[];
  suffix: string[];
}

const EVM_RPC_ALLOWLIST: RpcAllowlist = {
  exact: ['mainnet.base.org', 'cloudflare-eth.com', 'eth.llamarpc.com', 'base.llamarpc.com'],
  suffix: [
    '.alchemy.com',
    '.infura.io',
    '.publicnode.com',
    '.tenderly.co',
    '.blastapi.io',
    '.quicknode.pro',
    '.quiknode.pro',
    '.ankr.com',
    '.drpc.org',
  ],
};

const SOLANA_RPC_ALLOWLIST: RpcAllowlist = {
  exact: ['api.mainnet-beta.solana.com'],
  suffix: [
    '.helius-rpc.com',
    '.alchemy.com',
    '.publicnode.com',
    '.ankr.com',
    '.quicknode.pro',
    '.quiknode.pro',
    '.drpc.org',
  ],
};

// ---------------------------------------------------------------------------
// Aggregator router allowlists (PR 2.3)
// ---------------------------------------------------------------------------

/** 1inch v6 uses a deterministic CREATE2 address — same on every chain. */
const ONEINCH_V6_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';

/** EVM aggregator config. */
export interface EvmAggregatorConfig {
  name: string;
  routerAllowlist: string[];
}

/** Solana aggregator config. */
export interface SolanaAggregatorConfig {
  name: string;
  swapProgramAllowlist: string[];
  ancillaryProgramAllowlist: string[];
}

const EVM_AGGREGATOR: EvmAggregatorConfig = {
  name: '1inch-v6',
  routerAllowlist: [ONEINCH_V6_ROUTER],
};

/** Jupiter v6 swap program. */
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const SOLANA_AGGREGATOR: SolanaAggregatorConfig = {
  name: 'jupiter-v6',
  swapProgramAllowlist: [JUPITER_V6_PROGRAM],
  ancillaryProgramAllowlist: [
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
    'ComputeBudget111111111111111111111111111111', // Compute Budget
  ],
};

// ---------------------------------------------------------------------------
// Portfolio rules
// ---------------------------------------------------------------------------

/** Per-tier USD ceiling map. */
export interface TierMaxUsd {
  moonshot: number;
  conviction: number;
  base: number;
  [key: string]: number | undefined;
}

/** Portfolio rules shape (global defaults + per-chain overrides). */
export interface PortfolioRules {
  maxMoonshotPosition: number;
  maxConvictionPosition: number;
  maxBasePosition: number;
  maxMoonshotAllocation: number;
  minCashReserve: number;
  maxSameNarrative: number;
  maxOpenPositions: number;
  tiersEnabled: string[];
  tierMaxUsd: TierMaxUsd;
  quarantineTokenAgeHours: number;
}

export const PORTFOLIO_RULES: PortfolioRules = {
  maxMoonshotPosition: 5,
  maxConvictionPosition: 10,
  maxBasePosition: 30,
  maxMoonshotAllocation: 30,
  minCashReserve: 10,
  maxSameNarrative: 3,
  maxOpenPositions: 15,
  tiersEnabled: ['moonshot', 'conviction', 'base'],
  tierMaxUsd: { moonshot: 200, conviction: 500, base: 2000 },
  quarantineTokenAgeHours: 24,
};

// ---------------------------------------------------------------------------
// Token shapes
// ---------------------------------------------------------------------------

export interface TokenConfig {
  symbol: string;
  address: string;
  decimals: number;
}

export interface NativeTokenConfig {
  symbol: string;
  decimals: number;
}

// ---------------------------------------------------------------------------
// Chain shapes
// ---------------------------------------------------------------------------

/** Common fields shared by all chain types. */
export interface BaseChainConfig {
  name: string;
  type: 'evm' | 'solana';
  dexScreenerId: string;
  birdeye: string;
  nativeToken: NativeTokenConfig;
  wrappedNativeToken: TokenConfig;
  cashToken: TokenConfig;
  stablecoins: string[];
  baseTierTokens: TokenConfig[];
  portfolio: { provider: string; apiKeyEnv: string };
  signerThreshold: number;
  rules: Partial<PortfolioRules>;
}

/** GoPlus config for EVM chains. */
export interface GoplusEvmConfig {
  chainId: string;
}

/** GoPlus config for Solana. */
export interface GoplusSolanaConfig {
  endpoint: string;
}

/** Safe (EVM multisig) config. */
export interface SafeConfig {
  addressEnv: string;
  rpcEnv: string;
  txServiceUrl: string;
}

/** EVM explorer config. */
export interface EvmExplorerConfig {
  baseUrl: string;
  apiKeyEnv: string;
}

/** EVM chain — inherits base, adds Safe + 1inch. */
export interface EvmChain extends BaseChainConfig {
  type: 'evm';
  chainId: string;
  goplus: GoplusEvmConfig;
  explorer: EvmExplorerConfig;
  safe: SafeConfig;
  dex: '1inch';
  aggregator: EvmAggregatorConfig;
  rpcAllowlist: RpcAllowlist;
}

/** Squads (Solana multisig) config. */
export interface SquadsConfig {
  multisigEnv: string;
  vaultEnv: string;
  signerKeyEnv: string;
  rpcEnv: string;
  vaultIndex: number;
}

/** Solana-specific config block. */
export interface SolanaSpecificConfig {
  solscan: { baseUrl: string; apiKeyEnv: string };
  helius: { apiKeyEnv: string };
}

/** Jupiter DEX config. */
export interface JupiterConfig {
  apiUrl: string;
}

/** Solana chain — inherits base, adds Squads + Jupiter. */
export interface SolanaChain extends BaseChainConfig {
  type: 'solana';
  chainId: null;
  goplus: GoplusSolanaConfig;
  explorer: null;
  solana: SolanaSpecificConfig;
  squads: SquadsConfig;
  dex: 'jupiter';
  jupiter: JupiterConfig;
  aggregator: SolanaAggregatorConfig;
  rpcAllowlist: RpcAllowlist;
}

/** Union type for any chain config. */
export type Chain = EvmChain | SolanaChain;

// ---------------------------------------------------------------------------
// CHAINS map — values copied verbatim from scripts/chains.js
// ---------------------------------------------------------------------------

export const CHAINS: Record<string, Chain> = {
  base: {
    name: 'base',
    type: 'evm',
    chainId: '8453',
    dexScreenerId: 'base',
    goplus: { chainId: '8453' },
    explorer: { baseUrl: 'https://api.basescan.org/api', apiKeyEnv: 'BASESCAN_API_KEY' },
    birdeye: 'base',
    safe: {
      addressEnv: 'SAFE_ADDRESS_BASE',
      rpcEnv: 'RPC_BASE',
      txServiceUrl: 'https://safe-transaction-base.safe.global',
    },
    dex: '1inch',
    nativeToken: { symbol: 'ETH', decimals: 18 },
    wrappedNativeToken: { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
    cashToken: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    stablecoins: [
      '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // USDC
      '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // USDT
      '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb', // DAI
      '0x4621b7A9c75199271F773Ebd9A499dbd165c3191', // DOLA
    ],
    baseTierTokens: [
      { symbol: 'WETH', address: '0x4200000000000000000000000000000000000006', decimals: 18 },
      { symbol: 'cbBTC', address: '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', decimals: 8 },
    ],
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
    signerThreshold: 0.001,
    aggregator: EVM_AGGREGATOR,
    rpcAllowlist: EVM_RPC_ALLOWLIST,
    rules: {},
  } as EvmChain,
  ethereum: {
    name: 'ethereum',
    type: 'evm',
    chainId: '1',
    dexScreenerId: 'ethereum',
    goplus: { chainId: '1' },
    explorer: { baseUrl: 'https://api.etherscan.io/api', apiKeyEnv: 'ETHERSCAN_API_KEY' },
    birdeye: 'ethereum',
    safe: {
      addressEnv: 'SAFE_ADDRESS_ETH',
      rpcEnv: 'RPC_ETH',
      txServiceUrl: 'https://safe-transaction-mainnet.safe.global',
    },
    dex: '1inch',
    nativeToken: { symbol: 'ETH', decimals: 18 },
    wrappedNativeToken: { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
    cashToken: { symbol: 'USDC', address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', decimals: 6 },
    stablecoins: [
      '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      '0xdAC17F958D2ee523a2206206994597C13D831ec7', // USDT
      '0x6B175474E89094C44Da98b954EedeAC495271d0F', // DAI
    ],
    baseTierTokens: [
      { symbol: 'WETH', address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', decimals: 18 },
      { symbol: 'WBTC', address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', decimals: 8 },
    ],
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
    signerThreshold: 0.005,
    aggregator: EVM_AGGREGATOR,
    rpcAllowlist: EVM_RPC_ALLOWLIST,
    rules: {},
  } as EvmChain,
  solana: {
    name: 'solana',
    type: 'solana',
    chainId: null,
    dexScreenerId: 'solana',
    goplus: { endpoint: 'solana' },
    explorer: null,
    solana: {
      solscan: { baseUrl: 'https://pro-api.solscan.io/v2.0', apiKeyEnv: 'SOLSCAN_API_KEY' },
      helius: { apiKeyEnv: 'HELIUS_API_KEY' },
    },
    birdeye: 'solana',
    squads: {
      multisigEnv: 'SQUADS_MULTISIG_ADDRESS',
      vaultEnv: 'SQUADS_VAULT_ADDRESS',
      signerKeyEnv: 'SQUADS_SIGNER_KEY',
      rpcEnv: 'RPC_SOL',
      vaultIndex: 0,
    },
    dex: 'jupiter',
    jupiter: { apiUrl: 'https://lite-api.jup.ag/swap/v1' },
    nativeToken: { symbol: 'SOL', decimals: 9 },
    wrappedNativeToken: {
      symbol: 'WSOL',
      address: 'So11111111111111111111111111111111111111112',
      decimals: 9,
    },
    cashToken: {
      symbol: 'USDC',
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      decimals: 6,
    },
    stablecoins: [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
    ],
    baseTierTokens: [{ symbol: 'wSOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 }],
    portfolio: { provider: 'helius', apiKeyEnv: 'HELIUS_API_KEY' },
    signerThreshold: 0.05,
    aggregator: SOLANA_AGGREGATOR,
    rpcAllowlist: SOLANA_RPC_ALLOWLIST,
    rules: {
      maxMoonshotPosition: 7,
      maxMoonshotAllocation: 30,
      maxConvictionPosition: 10,
      tiersEnabled: ['moonshot', 'conviction'],
      maxOpenPositions: 10,
    },
  } as SolanaChain,
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/** Returns true if the chain is an EVM chain. */
export function isEvm(chain: Chain): chain is EvmChain {
  return chain.type === 'evm';
}

/** Returns true if the chain is a Solana chain. */
export function isSolana(chain: Chain): chain is SolanaChain {
  return chain.type === 'solana';
}

// ---------------------------------------------------------------------------
// Query helpers — mirrors the JS exports exactly
// ---------------------------------------------------------------------------

/**
 * Get full config for a chain by name. Throws if unknown.
 */
export function getChain(name: string): Chain {
  const chain = CHAINS[name];
  if (!chain) {
    throw new Error(`Unknown chain: ${name}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  return chain;
}

/**
 * Get list of active chain names from the provided env record.
 * Defaults to all known chains if ACTIVE_CHAINS is not set.
 *
 * Callers must pass the typed AppConfig (via ConfigService) or a plain env
 * object. Passing `process.env` directly is forbidden in libs/; callers
 * in libs/ should pass the env subset they already have from AppConfig.
 */
export function getActiveChains(env: Record<string, string | undefined>): string[] {
  const raw = env['ACTIVE_CHAINS'];
  if (!raw || raw.trim() === '') return ['base', 'ethereum', 'solana'];
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && CHAINS[c] !== undefined);
}

/**
 * Get all known chain names (not just active).
 */
export function getAllChains(): string[] {
  return Object.keys(CHAINS);
}

/**
 * Get merged portfolio rules for a chain.
 * Chain-specific overrides win, global defaults fill gaps.
 */
export function getPortfolioRules(chainName: string): PortfolioRules {
  const chain = getChain(chainName);
  const rules: PortfolioRules = { ...PORTFOLIO_RULES, ...chain.rules };
  // tierMaxUsd is a nested map — merge per-tier instead of replacing.
  rules.tierMaxUsd = {
    ...PORTFOLIO_RULES.tierMaxUsd,
    ...(chain.rules.tierMaxUsd ?? {}),
  };
  return rules;
}

/**
 * Get the absolute USD ceiling for a (chain, tier) pair, applying
 * env-var overrides last so operators can tune without redeploy.
 *
 * Precedence (highest first):
 *   1. env TIER_MAX_USD_<TIER>   (e.g. TIER_MAX_USD_MOONSHOT=300)
 *   2. chain.rules.tierMaxUsd[tier]
 *   3. PORTFOLIO_RULES.tierMaxUsd[tier]
 *
 * Returns a positive number, or null if no cap is configured.
 */
export function getTierMaxUsd(
  chainName: string,
  tier: string,
  env: Record<string, string | undefined> = {},
): number | null {
  if (!tier || typeof tier !== 'string') return null;
  const envKey = `TIER_MAX_USD_${tier.toUpperCase()}`;
  const envVal = parseFloat(env[envKey] ?? '');
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  const merged = getPortfolioRules(chainName);
  const cap = merged.tierMaxUsd[tier];
  return typeof cap === 'number' && Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Get the signer balance threshold for a chain (native token units).
 */
export function getSignerThreshold(chainName: string): number {
  return getChain(chainName).signerThreshold ?? 0.005;
}

/**
 * PR 4.1: quarantine duration for new tokens (hours).
 *
 * Precedence: env QUARANTINE_TOKEN_AGE_HOURS > chain override > global default (24).
 */
export function getQuarantineTokenAgeHours(chainName: string, env: Record<string, string | undefined> = {}): number {
  const envRaw = env['QUARANTINE_TOKEN_AGE_HOURS'];
  const envVal = parseFloat(envRaw ?? '');
  if (Number.isFinite(envVal) && envVal >= 0 && envRaw !== undefined && envRaw !== '') return envVal;
  const merged = getPortfolioRules(chainName);
  const v = merged.quarantineTokenAgeHours;
  return Number.isFinite(v) && v >= 0 ? v : 24;
}

/**
 * Get the cash token config for a chain.
 */
export function getCashToken(chainName: string): TokenConfig {
  return getChain(chainName).cashToken;
}

/**
 * Get stablecoin address Set for a chain (lowercased for EVM, exact for Solana).
 */
export function getStablecoins(chainName: string): Set<string> {
  const chain = getChain(chainName);
  const addrs = chain.stablecoins ?? [];
  if (chain.type === 'evm') {
    return new Set(addrs.map((a) => a.toLowerCase()));
  }
  return new Set(addrs);
}

/**
 * Get base tier tokens for a chain.
 */
export function getBaseTierTokens(chainName: string): TokenConfig[] {
  return getChain(chainName).baseTierTokens ?? [];
}

/**
 * Returns the aggregator config object for a chain, or null if the
 * chain has no DEX aggregator configured.
 */
export function getAggregator(chainName: string): EvmAggregatorConfig | SolanaAggregatorConfig | null {
  return (getChain(chainName).aggregator as EvmAggregatorConfig | SolanaAggregatorConfig) || null;
}

/**
 * EVM only. Returns true iff `address` is in the chain's router
 * allowlist (case-insensitive). False on null/missing address.
 */
export function isAllowedRouter(chainName: string, address: string | null | undefined): boolean {
  if (!address || typeof address !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg || !('routerAllowlist' in agg)) return false;
  const target = address.toLowerCase();
  return (agg as EvmAggregatorConfig).routerAllowlist.some((r) => r.toLowerCase() === target);
}

/**
 * Solana only. Returns true iff `programId` is the configured swap
 * program for this chain.
 */
export function isAllowedSwapProgram(chainName: string, programId: string | null | undefined): boolean {
  if (!programId || typeof programId !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg || !('swapProgramAllowlist' in agg)) return false;
  return (agg as SolanaAggregatorConfig).swapProgramAllowlist.includes(programId);
}

/**
 * Solana only. Returns true iff `programId` is allowed in setup or
 * cleanup instructions.
 */
export function isAllowedAncillaryProgram(chainName: string, programId: string | null | undefined): boolean {
  if (!programId || typeof programId !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg) return false;
  if (
    'ancillaryProgramAllowlist' in agg &&
    (agg as SolanaAggregatorConfig).ancillaryProgramAllowlist.includes(programId)
  ) {
    return true;
  }
  if ('swapProgramAllowlist' in agg && (agg as SolanaAggregatorConfig).swapProgramAllowlist.includes(programId)) {
    return true;
  }
  return false;
}

/**
 * PR 2.8: check an RPC URL against the chain's allowlist.
 * Returns false on malformed URL — fail-closed by design.
 */
export function isAllowedRpcUrl(chainName: string, rpcUrl: string | null | undefined): boolean {
  if (!rpcUrl || typeof rpcUrl !== 'string') return false;
  let hostname: string;
  try {
    hostname = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;

  let allowlist: RpcAllowlist | undefined;
  try {
    allowlist = getChain(chainName).rpcAllowlist;
  } catch {
    return false;
  }
  if (!allowlist) return false;

  if (Array.isArray(allowlist.exact) && allowlist.exact.some((h) => h.toLowerCase() === hostname)) {
    return true;
  }
  if (Array.isArray(allowlist.suffix) && allowlist.suffix.some((s) => hostname.endsWith(s.toLowerCase()))) {
    return true;
  }
  return false;
}
