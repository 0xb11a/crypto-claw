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
  maxMoonshotPosition: 5,      // % of chain portfolio
  maxConvictionPosition: 10,
  maxBasePosition: 50,
  maxMoonshotAllocation: 20,
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
    safe: { addressEnv: 'SAFE_ADDRESS_BASE', rpcEnv: 'RPC_BASE', txServiceUrl: 'https://safe-transaction-base.safe.global' },
    dex: '1inch',
    cashToken: { symbol: 'USDC', address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', decimals: 6 },
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
    rules: {},  // Base uses all global defaults
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
    cashToken: { symbol: 'USDC', address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6 },
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
  if (!raw || raw.trim() === '') return ['base'];
  return raw.split(',').map(c => c.trim()).filter(c => c.length > 0 && CHAINS[c]);
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
 * Get merged portfolio rules for a chain.
 * Chain-specific overrides win, global defaults fill gaps.
 */
export function getPortfolioRules(chainName) {
  const chain = getChain(chainName);
  return { ...PORTFOLIO_RULES, ...(chain.rules || {}) };
}

export { PORTFOLIO_RULES };
export default CHAINS;
