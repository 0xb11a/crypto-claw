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

const CHAINS = {
  base: {
    name: 'base',
    type: 'evm',
    chainId: '8453',
    dexScreenerId: 'base',
    goplus: { chainId: '8453' },
    explorer: { baseUrl: 'https://api.basescan.org/api', apiKeyEnv: 'BASESCAN_API_KEY' },
    birdeye: 'base',
    safe: { addressEnv: 'SAFE_ADDRESS_BASE', rpcEnv: 'RPC_BASE' },
    dex: '1inch',
    portfolio: { provider: 'debank', apiKeyEnv: 'DEBANK_API_KEY' },
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
    safe: { addressEnv: 'SAFE_ADDRESS_SOL', rpcEnv: 'RPC_SOL' },
    dex: 'jupiter',
    portfolio: { provider: null },
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

export default CHAINS;
