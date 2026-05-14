/**
 * Unit tests for queue-names.ts — BullMQ queue name constants.
 *
 * Mirrors the pattern from libs/modules/orders/src/queue-names.spec.ts.
 *
 * Covers:
 *   - All three constants are exported with the exact expected string values.
 *   - Constants are `as const` (immutable string literals, not just string).
 *   - No ':' separator (BullMQ rejects bare ':').
 *   - All three constants are distinct (no accidental aliasing).
 *   - Naming convention follows kebab-case with 'wallet-' prefix.
 *
 * SPEC §14 — unit tests; DoD §A — fails before / passes after.
 * P3g1 plan, Queue topology — single source of truth for queue names.
 */

import { describe, it, expect } from 'vitest';
import { WALLET_HARVEST_QUEUE, WALLET_SCORING_QUEUE, WALLET_ACTIVITY_QUEUE } from './queue-names.js';

describe('wallet pipeline queue-name constants', () => {
  // -------------------------------------------------------------------------
  // Exact string values (single source of truth — never hand-code these)
  // -------------------------------------------------------------------------

  it('WALLET_HARVEST_QUEUE equals "wallet-harvest"', () => {
    expect(WALLET_HARVEST_QUEUE).toBe('wallet-harvest');
  });

  it('WALLET_SCORING_QUEUE equals "wallet-scoring"', () => {
    expect(WALLET_SCORING_QUEUE).toBe('wallet-scoring');
  });

  it('WALLET_ACTIVITY_QUEUE equals "wallet-activity"', () => {
    expect(WALLET_ACTIVITY_QUEUE).toBe('wallet-activity');
  });

  // -------------------------------------------------------------------------
  // BullMQ constraint: no ':' separator
  // BullMQ uses ':' as an internal key separator — queue names must not contain it
  // -------------------------------------------------------------------------

  it('WALLET_HARVEST_QUEUE does not contain ":"', () => {
    expect(WALLET_HARVEST_QUEUE).not.toContain(':');
  });

  it('WALLET_SCORING_QUEUE does not contain ":"', () => {
    expect(WALLET_SCORING_QUEUE).not.toContain(':');
  });

  it('WALLET_ACTIVITY_QUEUE does not contain ":"', () => {
    expect(WALLET_ACTIVITY_QUEUE).not.toContain(':');
  });

  // -------------------------------------------------------------------------
  // Distinctness: three distinct names (accidental aliasing would collapse queues)
  // -------------------------------------------------------------------------

  it('all three queue names are distinct', () => {
    const names = [WALLET_HARVEST_QUEUE, WALLET_SCORING_QUEUE, WALLET_ACTIVITY_QUEUE];
    const unique = new Set(names);
    expect(unique.size).toBe(3);
  });

  // -------------------------------------------------------------------------
  // Naming convention: kebab-case with 'wallet-' prefix
  // -------------------------------------------------------------------------

  it('WALLET_HARVEST_QUEUE starts with "wallet-"', () => {
    expect(WALLET_HARVEST_QUEUE).toMatch(/^wallet-/);
  });

  it('WALLET_SCORING_QUEUE starts with "wallet-"', () => {
    expect(WALLET_SCORING_QUEUE).toMatch(/^wallet-/);
  });

  it('WALLET_ACTIVITY_QUEUE starts with "wallet-"', () => {
    expect(WALLET_ACTIVITY_QUEUE).toMatch(/^wallet-/);
  });

  it('all queue names are kebab-case (no underscores or uppercase)', () => {
    for (const name of [WALLET_HARVEST_QUEUE, WALLET_SCORING_QUEUE, WALLET_ACTIVITY_QUEUE]) {
      expect(name).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  // -------------------------------------------------------------------------
  // Type assertions: TypeScript `as const` narrows to literal type
  // These pass at runtime; the narrowing benefit is checked by typecheck.
  // -------------------------------------------------------------------------

  it('WALLET_HARVEST_QUEUE is a string primitive', () => {
    expect(typeof WALLET_HARVEST_QUEUE).toBe('string');
  });

  it('WALLET_SCORING_QUEUE is a string primitive', () => {
    expect(typeof WALLET_SCORING_QUEUE).toBe('string');
  });

  it('WALLET_ACTIVITY_QUEUE is a string primitive', () => {
    expect(typeof WALLET_ACTIVITY_QUEUE).toBe('string');
  });
});
