/**
 * chains.js — Centralized chain configuration (single source of truth)
 *
 * All chain metadata lives here. Scripts import from this module
 * instead of maintaining their own chain mappings.
 *
 * Usage:
 *   import { getChain, getActiveChains, isActive, isEVM, isSolana } from './chains.js';
 *   const chain = getChain('base');
 *   console.log(chain.goplus.chainId); // '8453'
 */

// ============================================================
// RPC hostname allowlists (PR 2.8)
//
// Defangs threat #14 (compromised RPC env var). If RPC_BASE / RPC_SOL
// is tampered to point at an attacker-controlled node, the attacker
// can: snoop the mempool to front-run signed txs, drop txs to censor,
// or return manipulated state reads (fake balance → bypass PR 2.4
// cash reconciliation).
//
// At execute time we extract the resolved hostname from the RPC URL
// and check it against this allowlist. Two match modes per chain:
//   - exact: full hostname match (e.g. 'mainnet.base.org')
//   - suffix: domain-suffix match (e.g. '.alchemy.com' covers
//     'eth-mainnet.g.alchemy.com', 'base-mainnet.g.alchemy.com', etc.
//     because providers issue per-API-key subdomains)
//
// Operator can bypass via RPC_VALIDATION_MODE=skip or run
// "warn-only" via =warn for the first 48h of a rollout.
// ============================================================

const EVM_RPC_ALLOWLIST = {
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

const SOLANA_RPC_ALLOWLIST = {
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

// ============================================================
// Aggregator router allowlists (PR 2.3)
//
// Defangs threat #13 (compromised aggregator API → arbitrary tx.to).
// If 1inch / Jupiter ever has its API or DNS compromised, an attacker
// could return a quote whose `tx.to` (EVM) or `swapInstruction.
// programId` (Solana) points at an attacker-controlled contract /
// program. With a maxUint256 USDC approval already granted to the
// real router (until PR 2.5 scopes it down), that's a wallet drain
// in one Safe-confirmed tx.
//
// We hard-allowlist the known-good targets at execute time and
// refuse anything else. The allowlist lives in chains.js (one source
// of truth, easy to audit, easy to bump on v6 → v7 transitions).
// ============================================================

// 1inch v6 uses a deterministic CREATE2 address — same on every chain
// where 1inch is deployed (Ethereum, Base, Polygon, Arbitrum, etc.).
const ONEINCH_V6_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';

const EVM_AGGREGATOR = {
  name: '1inch-v6',
  routerAllowlist: [ONEINCH_V6_ROUTER],
};

// Jupiter v6 swap program. Setup/cleanup may use standard Solana
// system programs — those go in ancillaryProgramAllowlist below.
const JUPITER_V6_PROGRAM = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';

const SOLANA_AGGREGATOR = {
  name: 'jupiter-v6',
  swapProgramAllowlist: [JUPITER_V6_PROGRAM],
  // Programs Jupiter legitimately uses in setupInstructions (ATA
  // creation, wSOL wrapping) and cleanupInstruction (account close).
  // If Jupiter ever introduces a new ancillary program here, the
  // executor will fail-loud and the operator must update this list
  // — better than silently approving an attacker-injected instruction.
  ancillaryProgramAllowlist: [
    '11111111111111111111111111111111', // System Program
    'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // SPL Token
    'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', // Token-2022
    'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Account
    'ComputeBudget111111111111111111111111111111', // Compute Budget
  ],
};

// Global default portfolio rules (applied to any chain that doesn't override)
const PORTFOLIO_RULES = {
  maxMoonshotPosition: 5, // % of chain portfolio
  maxConvictionPosition: 10,
  maxBasePosition: 30,
  maxMoonshotAllocation: 30,
  minCashReserve: 10,
  maxSameNarrative: 3,
  maxOpenPositions: 15,
  tiersEnabled: ['moonshot', 'conviction', 'base'],
  // PR 2.1: hard absolute USD ceilings per tier, enforced at execution
  // time in process-order.js. Defangs threat #5 (cash-balance
  // poisoning): even if portfolio_meta.cash_* is forged to $1M, an
  // attacker can't drain more than $200/$500/$2000 per individual
  // order. Tunable per fund via env var TIER_MAX_USD_<TIER> (uppercase)
  // or per-chain override on chain.rules.tierMaxUsd.
  tierMaxUsd: { moonshot: 200, conviction: 500, base: 2000 },
  // PR 4.1: quarantine new tokens. Real-mode buys for tokens younger
  // than this threshold are refused with `quarantined_age` and an
  // alert to the Research Telegram topic. The operator can manually
  // approve via `db-query.js approve-order` to override.
  //
  // Why: the highest scam-risk window is the first 24h after listing
  // (rugpulls and post-launch contract upgrades cluster here). Forcing
  // novel tokens to age before real capital touches them eliminates
  // the worst tier of moonshot losses without blocking high-conviction
  // operator-approved opportunities.
  //
  // Tunable per fund via QUARANTINE_TOKEN_AGE_HOURS env (set 0 to
  // disable, 12 to relax, 48 to tighten). Skipped in paper mode.
  quarantineTokenAgeHours: 24,
};

const CHAINS = {
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
    signerThreshold: 0.001, // ETH — L2 gas is cheap
    aggregator: EVM_AGGREGATOR,
    rpcAllowlist: EVM_RPC_ALLOWLIST,
    rules: {}, // Base uses all global defaults
  },
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
    signerThreshold: 0.005, // ETH — mainnet gas is expensive
    aggregator: EVM_AGGREGATOR,
    rpcAllowlist: EVM_RPC_ALLOWLIST,
    rules: {}, // Ethereum uses all global defaults (same as Base)
  },
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
    wrappedNativeToken: { symbol: 'WSOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 },
    cashToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
    stablecoins: [
      'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', // USDC
      'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', // USDT
      'USDSwr9ApdHk5bvJKMjzff41FfuX8bSxdKcR81vTwcA', // USDS
    ],
    baseTierTokens: [{ symbol: 'wSOL', address: 'So11111111111111111111111111111111111111112', decimals: 9 }],
    portfolio: { provider: 'helius', apiKeyEnv: 'HELIUS_API_KEY' },
    signerThreshold: 0.05, // SOL
    aggregator: SOLANA_AGGREGATOR,
    rpcAllowlist: SOLANA_RPC_ALLOWLIST,
    rules: {
      maxMoonshotPosition: 7,
      maxMoonshotAllocation: 30,
      maxConvictionPosition: 10,
      tiersEnabled: ['moonshot', 'conviction'],
      maxOpenPositions: 10,
    },
  },
};

/**
 * Get list of active chain names from ACTIVE_CHAINS env var.
 * Defaults to ['base'] if not set.
 */
export function getActiveChains() {
  const raw = process.env.ACTIVE_CHAINS;
  if (!raw || raw.trim() === '') return ['base', 'ethereum', 'solana'];
  return raw
    .split(',')
    .map((c) => c.trim())
    .filter((c) => c.length > 0 && CHAINS[c]);
}

/**
 * Get full config for a chain by name. Throws if unknown.
 */
export function getChain(name) {
  const chain = CHAINS[name];
  if (!chain) {
    throw new Error(`Unknown chain: ${name}. Supported: ${Object.keys(CHAINS).join(', ')}`);
  }
  return chain;
}

/**
 * Check if a chain is in the active set.
 */
export function isActive(name) {
  return getActiveChains().includes(name);
}

/**
 * Check if a chain is EVM-type.
 */
export function isEVM(name) {
  return CHAINS[name]?.type === 'evm';
}

/**
 * Check if a chain is Solana-type.
 */
export function isSolana(name) {
  return CHAINS[name]?.type === 'solana';
}

/**
 * Get all known chain names (not just active).
 */
export function getAllChains() {
  return Object.keys(CHAINS);
}

/**
 * Get the cash token config for a chain.
 */
export function getCashToken(chainName) {
  return getChain(chainName).cashToken;
}

/**
 * Get stablecoin address Set for a chain (lowercased for EVM, exact for Solana).
 */
export function getStablecoins(chainName) {
  const chain = getChain(chainName);
  const addrs = chain.stablecoins ?? [];
  if (chain.type === 'evm') {
    return new Set(addrs.map((a) => a.toLowerCase()));
  }
  return new Set(addrs);
}

/**
 * Get merged portfolio rules for a chain.
 * Chain-specific overrides win, global defaults fill gaps.
 */
export function getPortfolioRules(chainName) {
  const chain = getChain(chainName);
  const rules = { ...PORTFOLIO_RULES, ...(chain.rules || {}) };
  // tierMaxUsd is a nested map — merge per-tier instead of replacing.
  rules.tierMaxUsd = {
    ...(PORTFOLIO_RULES.tierMaxUsd || {}),
    ...((chain.rules || {}).tierMaxUsd || {}),
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
 * Returns a positive number, or null if no cap is configured for that
 * tier (caller should treat null as "no absolute ceiling — % rules
 * still apply upstream"). Negative or zero values are normalized to
 * null so a misconfigured env var doesn't silently disable the cap.
 *
 * @param {string} chainName
 * @param {string} tier
 * @param {object} [env]
 * @returns {number|null}
 */
export function getTierMaxUsd(chainName, tier, env = process.env) {
  if (!tier || typeof tier !== 'string') return null;
  const envKey = `TIER_MAX_USD_${tier.toUpperCase()}`;
  const envVal = parseFloat(env[envKey] ?? '');
  if (Number.isFinite(envVal) && envVal > 0) return envVal;
  const merged = getPortfolioRules(chainName);
  const cap = merged.tierMaxUsd?.[tier];
  return Number.isFinite(cap) && cap > 0 ? cap : null;
}

/**
 * Get base tier tokens for a chain.
 */
export function getBaseTierTokens(chainName) {
  return getChain(chainName).baseTierTokens ?? [];
}

/**
 * Get the signer balance threshold for a chain (native token units).
 * Below this, the signer account needs a top-up to keep paying tx fees.
 */
export function getSignerThreshold(chainName) {
  return getChain(chainName).signerThreshold ?? 0.005;
}

// ============================================================
// PR 2.3: Aggregator router/program helpers
// ============================================================

/**
 * Returns the aggregator config object for a chain, or null if the
 * chain has no DEX aggregator configured.
 */
export function getAggregator(chainName) {
  return getChain(chainName).aggregator || null;
}

/**
 * EVM only. Returns true iff `address` is in the chain's router
 * allowlist (case-insensitive). False on null/missing address.
 */
export function isAllowedRouter(chainName, address) {
  if (!address || typeof address !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg?.routerAllowlist) return false;
  const target = address.toLowerCase();
  return agg.routerAllowlist.some((r) => r.toLowerCase() === target);
}

/**
 * Solana only. Returns true iff `programId` is the configured swap
 * program for this chain. (Setup/cleanup programs are validated
 * separately via isAllowedAncillaryProgram.)
 */
export function isAllowedSwapProgram(chainName, programId) {
  if (!programId || typeof programId !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg?.swapProgramAllowlist) return false;
  return agg.swapProgramAllowlist.includes(programId);
}

/**
 * Solana only. Returns true iff `programId` is allowed in setup or
 * cleanup instructions. The swap program itself is also accepted —
 * Jupiter occasionally emits multi-leg instructions that route
 * through the swap program in cleanup.
 */
export function isAllowedAncillaryProgram(chainName, programId) {
  if (!programId || typeof programId !== 'string') return false;
  const agg = getAggregator(chainName);
  if (!agg) return false;
  if (agg.ancillaryProgramAllowlist?.includes(programId)) return true;
  if (agg.swapProgramAllowlist?.includes(programId)) return true;
  return false;
}

/**
 * PR 4.1: quarantine duration for new tokens. Returns the number of
 * hours a token must age before real-mode buys are allowed.
 *
 * Precedence (highest first):
 *   1. env QUARANTINE_TOKEN_AGE_HOURS (operator-tunable per fund)
 *   2. chain.rules.quarantineTokenAgeHours (chain-specific override)
 *   3. PORTFOLIO_RULES.quarantineTokenAgeHours (24h default)
 *
 * Returns 0 to mean "quarantine disabled". Negative env values are
 * normalized to the chain default so a misconfigured env doesn't
 * silently disable the gate.
 */
export function getQuarantineTokenAgeHours(chainName, env = process.env) {
  const envRaw = env.QUARANTINE_TOKEN_AGE_HOURS;
  const envVal = parseFloat(envRaw ?? '');
  if (Number.isFinite(envVal) && envVal >= 0 && envRaw !== undefined && envRaw !== '') return envVal;
  const merged = getPortfolioRules(chainName);
  const v = merged.quarantineTokenAgeHours;
  return Number.isFinite(v) && v >= 0 ? v : 24;
}

/**
 * PR 2.8: extract hostname from RPC URL and check it against the
 * chain's RPC allowlist. Two match modes:
 *   - exact: full hostname match
 *   - suffix: domain-suffix match (covers per-API-key subdomains
 *     like "eth-mainnet.g.alchemy.com")
 *
 * Returns false on any malformed URL — fail-closed by design.
 *
 * @param {string} chainName
 * @param {string} rpcUrl
 * @returns {boolean}
 */
export function isAllowedRpcUrl(chainName, rpcUrl) {
  if (!rpcUrl || typeof rpcUrl !== 'string') return false;
  let hostname;
  try {
    hostname = new URL(rpcUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (!hostname) return false;

  let allowlist;
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

export { PORTFOLIO_RULES };
export default CHAINS;
