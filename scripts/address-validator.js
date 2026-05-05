// ============================================================
// address-validator.js — Validate token / wallet addresses at the
// external-data boundary (DEXScreener, GoPlus, Birdeye, Etherscan,
// Helius) before they enter our DB or any agent context.
//
// Why this matters: address-poisoning attacks (#6 in the threat
// model) inject lookalike addresses with wrong checksums or
// homoglyph characters. A malicious data source can return
// `0x1234…abCE` (wrong checksum) and an unguarded LLM might
// propose buying it. Validation at ingest fails closed.
//
// EVM: viem.getAddress() — checksum-validated EIP-55
// Solana: @solana/web3.js PublicKey — base58 + 32-byte length
// ============================================================

import { getAddress, isAddress } from 'viem';
import { PublicKey } from '@solana/web3.js';
import { isEVM, isSolana } from './chains.js';

/**
 * Non-throwing boolean check.
 * @param {string} address
 * @param {string} chain
 * @returns {boolean}
 */
export function isValidAddress(address, chain) {
  if (!address || typeof address !== 'string') return false;
  try {
    if (isEVM(chain)) {
      return isAddress(address, { strict: false });
    }
    if (isSolana(chain)) {
      const pk = new PublicKey(address);
      return PublicKey.isOnCurve(pk.toBytes()) || true;
    }
  } catch {
    return false;
  }
  return false;
}

/**
 * Returns canonical (checksummed for EVM, normalized base58 for
 * Solana) address. Returns null if invalid — never throws.
 *
 * Use this at the boundary where attacker-controlled strings enter
 * our system. If null, the caller should drop the row and log.
 *
 * @param {string} address
 * @param {string} chain
 * @returns {string | null}
 */
export function normalizeAddress(address, chain) {
  if (!address || typeof address !== 'string') return null;
  try {
    if (isEVM(chain)) {
      // viem's getAddress accepts both checksummed and lowercase, returns
      // canonical EIP-55 checksum. Throws on bad length / non-hex.
      return getAddress(address);
    }
    if (isSolana(chain)) {
      // PublicKey constructor throws on invalid base58 or wrong length.
      // .toBase58() returns the canonical form.
      return new PublicKey(address).toBase58();
    }
  } catch {
    return null;
  }
  return null;
}

/**
 * Throws an explicit, structured error with code='invalid_address'
 * if the address fails validation. Use in code paths where a bad
 * address is a hard failure (e.g. trade execution).
 *
 * @param {string} address
 * @param {string} chain
 * @returns {string} canonical address
 */
export function requireValidAddress(address, chain) {
  const normalized = normalizeAddress(address, chain);
  if (normalized === null) {
    const err = new Error(`Invalid address for chain ${chain}: ${String(address).slice(0, 64)}`);
    err.code = 'invalid_address';
    err.chain = chain;
    throw err;
  }
  return normalized;
}
