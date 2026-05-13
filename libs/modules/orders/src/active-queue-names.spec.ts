/**
 * Unit tests for active-queue-names.ts — resolveActiveQueueNames + buildChainQueueMap.
 *
 * Adversarial cases the coder flagged as gaps (plan §B.4):
 *   - Unknown chain name → silently skipped (no throw), resulting map excludes it.
 *   - Chain with no env var → silently skipped, map excludes it.
 *   - Whitespace-only env var → silently skipped.
 *   - Solana: SQUADS_VAULT_ADDRESS takes priority over SQUADS_MULTISIG_ADDRESS.
 *   - Two distinct Safes produce two distinct queue names (C — static guarantee).
 *
 * No NestJS deps — these are pure functions safe to unit-test with process.env stubs.
 *
 * SPEC §14 — unit tests; DoD §A; ADR-0024 addendum.
 */

import { describe, it, expect } from 'vitest';
import { resolveActiveQueueNames, buildChainQueueMap } from './active-queue-names.js';

// ---------------------------------------------------------------------------
// Minimal env stubs
// ---------------------------------------------------------------------------

const BASE_ONLY_ENV: Record<string, string | undefined> = {
  SAFE_ADDRESS_BASE: '0xbaseSafe000000000000000000000000000000001',
};

const ETH_ONLY_ENV: Record<string, string | undefined> = {
  SAFE_ADDRESS_ETH: '0xethSafe0000000000000000000000000000000001',
};

const SOLANA_VAULT_ENV: Record<string, string | undefined> = {
  SQUADS_VAULT_ADDRESS: 'solanaVaultAddr',
};

const SOLANA_MULTISIG_ENV: Record<string, string | undefined> = {
  SQUADS_MULTISIG_ADDRESS: 'solanaMultisigAddr',
};

const SOLANA_BOTH_ENV: Record<string, string | undefined> = {
  SQUADS_VAULT_ADDRESS: 'solanaVaultPriority',
  SQUADS_MULTISIG_ADDRESS: 'solanaMultisigFallback',
};

const TWO_SAFES_ENV: Record<string, string | undefined> = {
  SAFE_ADDRESS_BASE: '0xbaseSafe000000000000000000000000000000001',
  SAFE_ADDRESS_ETH: '0xethSafe0000000000000000000000000000000001',
};

// ---------------------------------------------------------------------------
// resolveActiveQueueNames()
// ---------------------------------------------------------------------------

describe('resolveActiveQueueNames()', () => {
  it('returns one queue name for a known EVM chain with a configured safe', () => {
    const names = resolveActiveQueueNames(['base'], BASE_ONLY_ENV);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^execute-order-base-/);
  });

  it('includes the safe address (lowercased) in the queue name', () => {
    const env = { SAFE_ADDRESS_BASE: '0xABCDEF' };
    const names = resolveActiveQueueNames(['base'], env);
    expect(names[0]).toContain('0xabcdef');
  });

  it('silently skips unknown chain names — no throw (adversarial — plan §B.4)', () => {
    expect(() => resolveActiveQueueNames(['completely-unknown-chain'], {})).not.toThrow();
    expect(resolveActiveQueueNames(['completely-unknown-chain'], {})).toHaveLength(0);
  });

  it('silently skips chains with missing env var (adversarial — plan §B.4)', () => {
    // base is a real chain but SAFE_ADDRESS_BASE is not in the env
    expect(resolveActiveQueueNames(['base'], {})).toHaveLength(0);
  });

  it('silently skips chains with whitespace-only env var (adversarial — plan §B.4)', () => {
    const env = { SAFE_ADDRESS_BASE: '   ' };
    expect(resolveActiveQueueNames(['base'], env)).toHaveLength(0);
  });

  it('handles multiple active chains producing multiple queue names', () => {
    const names = resolveActiveQueueNames(['base', 'ethereum'], TWO_SAFES_ENV);
    expect(names).toHaveLength(2);
  });

  it('two distinct Safes produce two distinct queue names (ADR-0024 §C guarantee)', () => {
    const names = resolveActiveQueueNames(['base', 'ethereum'], TWO_SAFES_ENV);
    expect(names[0]).not.toBe(names[1]);
  });

  it('returns empty array when activeChains is empty', () => {
    expect(resolveActiveQueueNames([], BASE_ONLY_ENV)).toHaveLength(0);
  });

  it('Solana: picks up SQUADS_VAULT_ADDRESS', () => {
    const names = resolveActiveQueueNames(['solana'], SOLANA_VAULT_ENV);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('solanavaultaddr');
  });

  it('Solana: falls back to SQUADS_MULTISIG_ADDRESS when SQUADS_VAULT_ADDRESS is absent', () => {
    const names = resolveActiveQueueNames(['solana'], SOLANA_MULTISIG_ENV);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('solanamultisigaddr');
  });

  it('Solana: SQUADS_VAULT_ADDRESS takes priority over SQUADS_MULTISIG_ADDRESS (CLAUDE.md)', () => {
    const names = resolveActiveQueueNames(['solana'], SOLANA_BOTH_ENV);
    expect(names).toHaveLength(1);
    expect(names[0]).toContain('solanavaultpriority');
    expect(names[0]).not.toContain('solanamultisigfallback');
  });

  it('unknown chain mixed with known chain — known chain still resolves', () => {
    const names = resolveActiveQueueNames(['unknown-chain', 'base'], BASE_ONLY_ENV);
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^execute-order-base-/);
  });
});

// ---------------------------------------------------------------------------
// buildChainQueueMap()
// ---------------------------------------------------------------------------

describe('buildChainQueueMap()', () => {
  it('returns a Map with chain name as key and queue name as value', () => {
    const map = buildChainQueueMap(['base'], BASE_ONLY_ENV);
    expect(map.size).toBe(1);
    expect(map.has('base')).toBe(true);
    expect(map.get('base')).toMatch(/^execute-order-base-/);
  });

  it('silently skips unknown chains — resulting map excludes them (adversarial — plan §B.4)', () => {
    const map = buildChainQueueMap(['unknown-chain', 'base'], BASE_ONLY_ENV);
    expect(map.has('unknown-chain')).toBe(false);
    expect(map.has('base')).toBe(true);
    expect(map.size).toBe(1);
  });

  it('silently skips chains with no env var — no throw, no entry (adversarial — plan §B.4)', () => {
    expect(() => buildChainQueueMap(['base'], {})).not.toThrow();
    expect(buildChainQueueMap(['base'], {})).toEqual(new Map());
  });

  it('silently skips chains with whitespace-only env var (adversarial — plan §B.4)', () => {
    const env = { SAFE_ADDRESS_BASE: '   ' };
    expect(buildChainQueueMap(['base'], env).size).toBe(0);
  });

  it('two distinct chains produce two distinct entries', () => {
    const map = buildChainQueueMap(['base', 'ethereum'], TWO_SAFES_ENV);
    expect(map.size).toBe(2);
    const names = [...map.values()];
    expect(names[0]).not.toBe(names[1]);
  });

  it('Solana: SQUADS_VAULT_ADDRESS takes priority (CLAUDE.md)', () => {
    const map = buildChainQueueMap(['solana'], SOLANA_BOTH_ENV);
    expect(map.get('solana')).toContain('solanavaultpriority');
  });

  it('Solana: falls back to SQUADS_MULTISIG_ADDRESS', () => {
    const map = buildChainQueueMap(['solana'], SOLANA_MULTISIG_ENV);
    expect(map.get('solana')).toContain('solanamultisigaddr');
  });

  it('returns empty Map for empty activeChains', () => {
    expect(buildChainQueueMap([], BASE_ONLY_ENV).size).toBe(0);
  });

  it('ETH chain uses SAFE_ADDRESS_ETH env var', () => {
    const map = buildChainQueueMap(['ethereum'], ETH_ONLY_ENV);
    expect(map.size).toBe(1);
    expect(map.get('ethereum')).toMatch(/^execute-order-ethereum-/);
  });
});
