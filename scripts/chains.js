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
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
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
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
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
    portfolio: { provider: 'helius', apiKeyEnv: 'HELIUS_API_KEY' },
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
  return { ...PORTFOLIO_RULES, ...(chain.rules || {}) };
}

export { PORTFOLIO_RULES };
export default CHAINS;
