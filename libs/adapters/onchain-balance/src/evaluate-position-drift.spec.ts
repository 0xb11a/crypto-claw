/**
 * Unit tests for evaluatePositionDrift (SPEC §14, DoD §A, §I).
 *
 * This is a pure function; no mocks needed.
 *
 * Bug-for-bug parity with `scripts/onchain-balance.js:evaluatePositionDrift` (DoD §I).
 * Table-driven boundary tests around the default 1% drift threshold.
 *
 * Cases:
 *   - No drift (identical values)
 *   - Drift < 1% → valid=true
 *   - Drift = exactly 1% → valid=true (boundary: >, not >=)
 *   - Drift = 1.001% → valid=false
 *   - Drift > 1% (large short/over) → valid=false with correct direction
 *   - On-chain balance = 0 (position fully exited or rug)
 *   - On-chain balance > DB (incoming buy / mint)
 *   - DB > on-chain (fee-on-transfer drain, confiscation)
 *   - Both below dust threshold → valid=true, driftPct=0
 *   - One side below dust, other above → counted via max(dbQty, minDustQty) denom
 *   - Custom maxDriftPct
 *   - Custom minDustQty
 *   - Invalid inputs: negative dbQty, negative onchainQty, NaN, Infinity
 */

import { describe, it, expect } from 'vitest';
import { evaluatePositionDrift } from './evaluate-position-drift.js';

// ---------------------------------------------------------------------------
// Helper: shorthand for calling the function
// ---------------------------------------------------------------------------

function drift(dbQty: number, onchainQty: number, opts?: { maxDriftPct?: number; minDustQty?: number }) {
  return evaluatePositionDrift({ dbQty, onchainQty, ...opts });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('evaluatePositionDrift', () => {
  // -------------------------------------------------------------------------
  // No drift
  // -------------------------------------------------------------------------

  describe('no drift (identical values)', () => {
    it('returns valid=true, driftPct=0, direction=none for equal values', () => {
      const result = drift(100, 100);
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBe(0);
      expect(result.direction).toBe('none');
    });

    it('returns valid=true for 0 both sides (dust)', () => {
      const result = drift(0, 0);
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBe(0);
      expect(result.direction).toBe('none');
    });

    it('returns valid=true for tiny matching values below dust threshold', () => {
      const result = drift(0.0000005, 0.0000005); // both < 0.000001
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Drift within 1% threshold
  // -------------------------------------------------------------------------

  describe('drift < 1% (within threshold)', () => {
    it('returns valid=true for 0.5% drift (over direction)', () => {
      const result = drift(100, 100.5);
      expect(result.valid).toBe(true);
      expect(result.direction).toBe('over');
      expect(result.driftPct).toBeCloseTo(0.5, 4);
    });

    it('returns valid=true for 0.5% drift (short direction)', () => {
      const result = drift(100, 99.5);
      expect(result.valid).toBe(true);
      expect(result.direction).toBe('short');
    });

    it('returns valid=true for 0.99% drift (just under threshold)', () => {
      const result = drift(100, 100.99);
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBeCloseTo(0.99, 2);
    });

    it('returns valid=true for tiny fractional token at 0.5% drift', () => {
      // 0.001 WBTC, on-chain 0.0010005 (0.05% drift)
      const result = drift(0.001, 0.0010005);
      expect(result.valid).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Drift exactly at threshold boundary
  // -------------------------------------------------------------------------

  describe('drift exactly at 1% threshold (boundary: > not >=)', () => {
    it('returns valid=true when drift = exactly 1.00%', () => {
      // driftPct = (100.99 - 100) / 100 * 100 does NOT reach 1.00 exactly;
      // use 101 - 100 = 1.00% exactly.
      const result = drift(100, 101); // diff = 1, denom = 100, pct = 1.00
      // The condition is absDriftPct > maxDriftPct, so exactly 1.00% is VALID
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBeCloseTo(1.0, 10);
    });
  });

  // -------------------------------------------------------------------------
  // Drift above threshold
  // -------------------------------------------------------------------------

  describe('drift > 1% (exceeds threshold)', () => {
    it('returns valid=false for 1.001% drift', () => {
      // 100 → 101.001: diff=1.001, pct=1.001% > 1%
      const result = drift(100, 101.001);
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('over');
    });

    it('returns valid=false for 5% short drift', () => {
      const result = drift(100, 95);
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('short');
      expect(result.driftPct).toBeCloseTo(5.0, 2);
    });

    it('returns valid=false for 10% over drift', () => {
      const result = drift(100, 110);
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('over');
      expect(result.driftPct).toBeCloseTo(10.0, 2);
    });

    it('includes a human-readable reason string', () => {
      const result = drift(100, 90);
      expect(result.reason).toBeDefined();
      expect(result.reason).toMatch(/position_drift/);
      expect(result.reason).toMatch(/db=100/);
      expect(result.reason).toMatch(/onchain=90/);
    });

    it('reason includes direction', () => {
      const result = drift(100, 90);
      expect(result.reason).toMatch(/direction=short/);
    });
  });

  // -------------------------------------------------------------------------
  // On-chain balance = 0 (fully exited / rug / confiscation)
  // -------------------------------------------------------------------------

  describe('on-chain balance = 0 (position fully exited or rug)', () => {
    it('returns valid=false for 100% short drift when dbQty > 0', () => {
      const result = drift(100, 0);
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('short');
      expect(result.driftPct).toBeCloseTo(100, 0);
    });

    it('returns valid=false reason includes position_drift', () => {
      const result = drift(50, 0);
      expect(result.reason).toMatch(/position_drift/);
    });
  });

  // -------------------------------------------------------------------------
  // On-chain balance > DB (incoming buy / mint / rebase)
  // -------------------------------------------------------------------------

  describe('on-chain balance > DB (incoming transfer)', () => {
    it('returns valid=false for large over-balance with direction=over', () => {
      const result = drift(100, 200); // 100% over
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('over');
      expect(result.driftPct).toBeCloseTo(100, 0);
    });

    it('returns valid=true for small over-balance within 1%', () => {
      const result = drift(100, 100.8);
      expect(result.valid).toBe(true);
      expect(result.direction).toBe('over');
    });
  });

  // -------------------------------------------------------------------------
  // Dust threshold edge cases
  // -------------------------------------------------------------------------

  describe('dust threshold (minDustQty = 0.000001 default)', () => {
    it('both below dust → valid=true with driftPct=0', () => {
      const result = drift(0.0000005, 0.0000009);
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBe(0);
      expect(result.direction).toBe('none');
    });

    it('dbQty below dust but onchainQty above → uses minDustQty as denominator', () => {
      // dbQty=0 (dust), onchainQty=0.0001
      // denom = max(0, 0.000001) = 0.000001
      // diff = 0.0001, pct = (0.0001 / 0.000001) * 100 = 10000%
      const result = drift(0, 0.0001);
      expect(result.valid).toBe(false);
      expect(result.direction).toBe('over');
      expect(result.driftPct).toBeGreaterThan(100);
    });
  });

  // -------------------------------------------------------------------------
  // Custom maxDriftPct
  // -------------------------------------------------------------------------

  describe('custom maxDriftPct', () => {
    it('uses custom 5% threshold correctly', () => {
      const result = drift(100, 104, { maxDriftPct: 5 });
      expect(result.valid).toBe(true); // 4% < 5%
    });

    it('returns valid=false when exceeding custom threshold', () => {
      const result = drift(100, 106, { maxDriftPct: 5 });
      expect(result.valid).toBe(false); // 6% > 5%
    });

    it('uses custom 0.1% threshold (stricter)', () => {
      const result = drift(100, 100.2, { maxDriftPct: 0.1 });
      expect(result.valid).toBe(false); // 0.2% > 0.1%
    });
  });

  // -------------------------------------------------------------------------
  // Custom minDustQty
  // -------------------------------------------------------------------------

  describe('custom minDustQty', () => {
    it('respects custom dust floor', () => {
      // Both below 0.01 dust floor → valid=true
      const result = drift(0.005, 0.009, { minDustQty: 0.01 });
      expect(result.valid).toBe(true);
      expect(result.driftPct).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Invalid inputs
  // -------------------------------------------------------------------------

  describe('invalid inputs', () => {
    it('returns valid=false for negative dbQty', () => {
      const result = drift(-1, 100);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_db_qty/);
      expect(Number.isNaN(result.driftPct)).toBe(true);
    });

    it('returns valid=false for negative onchainQty', () => {
      const result = drift(100, -1);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_onchain_qty/);
    });

    it('returns valid=false for NaN dbQty', () => {
      const result = drift(NaN, 100);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_db_qty/);
    });

    it('returns valid=false for Infinity dbQty', () => {
      const result = drift(Infinity, 100);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_db_qty/);
    });

    it('returns valid=false for NaN onchainQty', () => {
      const result = drift(100, NaN);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_onchain_qty/);
    });

    it('returns valid=false for Infinity onchainQty', () => {
      const result = drift(100, Infinity);
      expect(result.valid).toBe(false);
      expect(result.reason).toMatch(/invalid_onchain_qty/);
    });
  });

  // -------------------------------------------------------------------------
  // Direction field
  // -------------------------------------------------------------------------

  describe('direction field', () => {
    it('direction=none when equal', () => {
      expect(drift(10, 10).direction).toBe('none');
    });

    it('direction=short when on-chain < DB', () => {
      expect(drift(100, 90).direction).toBe('short');
    });

    it('direction=over when on-chain > DB', () => {
      expect(drift(100, 110).direction).toBe('over');
    });
  });

  // -------------------------------------------------------------------------
  // driftPct precision (reason string format)
  // -------------------------------------------------------------------------

  describe('driftPct precision', () => {
    it('reason contains drift formatted to 2 decimal places', () => {
      const result = drift(100, 85); // 15% drift
      expect(result.reason).toContain('drift=15.00%');
    });
  });
});
