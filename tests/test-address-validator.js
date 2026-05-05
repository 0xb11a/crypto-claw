#!/usr/bin/env node
/**
 * Test Suite: Address Validator
 *
 * Address-poisoning defense at the external-data boundary
 * (#6 in the threat model: scan-tokens.js / token-metrics.js / etc.
 * receive raw addresses from DEXScreener, Birdeye, etc., which can
 * be lookalike/wrong-checksum/wrong-length attacker payloads).
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';
import { isValidAddress, normalizeAddress, requireValidAddress } from '../scripts/address-validator.js';

// Real, well-known addresses (canonical form) for happy-path tests.
const USDC_ETH = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const USDC_SOL = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

describe('isValidAddress() — boolean check', () => {
  test('accepts canonical EVM address', () => {
    assertEqual(isValidAddress(USDC_ETH, 'ethereum'), true);
    assertEqual(isValidAddress(USDC_BASE, 'base'), true);
  });

  test('accepts lowercase EVM address (no checksum)', () => {
    assertEqual(isValidAddress(USDC_ETH.toLowerCase(), 'ethereum'), true);
  });

  test('accepts canonical Solana address', () => {
    assertEqual(isValidAddress(USDC_SOL, 'solana'), true);
  });

  test('rejects EVM address with wrong length', () => {
    assertEqual(isValidAddress('0x1234', 'ethereum'), false);
    assertEqual(isValidAddress('0x' + 'a'.repeat(41), 'ethereum'), false);
  });

  test('rejects EVM address with non-hex chars', () => {
    assertEqual(isValidAddress('0x' + 'g'.repeat(40), 'ethereum'), false);
  });

  test('rejects Solana address with wrong length', () => {
    assertEqual(isValidAddress('abc', 'solana'), false);
    assertEqual(isValidAddress('1'.repeat(50), 'solana'), false);
  });

  test('rejects Solana address with invalid base58 chars (0/O/I/l)', () => {
    assertEqual(isValidAddress('0' + USDC_SOL.slice(1), 'solana'), false);
  });

  test('rejects null/undefined/non-string', () => {
    assertEqual(isValidAddress(null, 'ethereum'), false);
    assertEqual(isValidAddress(undefined, 'solana'), false);
    assertEqual(isValidAddress(123, 'ethereum'), false);
  });

  test('rejects when chain is unknown', () => {
    assertEqual(isValidAddress(USDC_ETH, 'mars'), false);
  });
});

describe('normalizeAddress() — returns canonical or null', () => {
  test('returns checksummed EVM address for lowercase input', () => {
    const out = normalizeAddress(USDC_ETH.toLowerCase(), 'ethereum');
    assertEqual(out, USDC_ETH);
  });

  test('returns same canonical form for already-checksummed input', () => {
    assertEqual(normalizeAddress(USDC_ETH, 'ethereum'), USDC_ETH);
  });

  test('returns canonical Solana address', () => {
    assertEqual(normalizeAddress(USDC_SOL, 'solana'), USDC_SOL);
  });

  test('returns null for invalid EVM address', () => {
    assertEqual(normalizeAddress('0xdead', 'ethereum'), null);
  });

  test('returns null for invalid Solana address', () => {
    assertEqual(normalizeAddress('not-base58!!!', 'solana'), null);
  });

  test('returns null for poisoned address with control chars', () => {
    assertEqual(normalizeAddress(USDC_ETH + '\x00evil', 'ethereum'), null);
    assertEqual(normalizeAddress(USDC_SOL + '​', 'solana'), null);
  });

  test('returns null for empty/null input', () => {
    assertEqual(normalizeAddress('', 'ethereum'), null);
    assertEqual(normalizeAddress(null, 'ethereum'), null);
  });
});

describe('requireValidAddress() — throws on invalid', () => {
  test('returns canonical address for valid input', () => {
    assertEqual(requireValidAddress(USDC_ETH.toLowerCase(), 'ethereum'), USDC_ETH);
  });

  test('throws structured error for invalid EVM address', () => {
    let caught = null;
    try {
      requireValidAddress('0xdead', 'ethereum');
    } catch (e) {
      caught = e;
    }
    assert(caught !== null, 'should throw');
    assertEqual(caught.code, 'invalid_address');
    assertEqual(caught.chain, 'ethereum');
  });

  test('throws structured error for invalid Solana address', () => {
    let caught = null;
    try {
      requireValidAddress('garbage', 'solana');
    } catch (e) {
      caught = e;
    }
    assert(caught !== null, 'should throw');
    assertEqual(caught.code, 'invalid_address');
  });

  test('truncates long input in error message (no log DOS)', () => {
    let caught = null;
    try {
      requireValidAddress('x'.repeat(10_000), 'ethereum');
    } catch (e) {
      caught = e;
    }
    assert(caught.message.length < 200, `error msg should be capped, got ${caught.message.length}`);
  });
});

process.exit(summary() ? 0 : 1);
