/**
 * evaluate-position-drift.ts — Pure drift predicate for position reconciliation.
 *
 * Bug-for-bug port of `scripts/onchain-balance.js:evaluatePositionDrift` (line 268).
 * Logic: given the DB-recorded position quantity vs the actual on-chain balance,
 * decide whether the position has drifted past the acceptable threshold.
 *
 * Use cases: continuous fee-on-transfer tokens draining slowly, rebase tokens,
 * Solana freeze-authority confiscation, backdoor mint dilution, or DB sync bugs.
 *
 * This is a pure function — no DI, no IO, no side effects.
 * Re-exported from the adapter's index.ts for use by position-reconcile processor.
 *
 * DoD §I: byte-identical behaviour with the legacy script.
 * DoD §F: no sensitive data touched.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PositionDriftInput {
  /** Quantity recorded in positions.quantity (DB). */
  dbQty: number;
  /** Human-readable on-chain balance from RPC. */
  onchainQty: number;
  /**
   * Acceptable drift percentage. Default: 1 (%).
   * Matches legacy `maxDriftPct = 1` (DoD §I).
   */
  maxDriftPct?: number;
  /**
   * Ignore drift on dust holdings below this threshold. Default: 0.000001.
   * Matches legacy `minDustQty = 0.000001` (DoD §I).
   */
  minDustQty?: number;
}

export interface PositionDriftResult {
  /** true if drift is within tolerance. */
  valid: boolean;
  /** Absolute drift percentage (NaN if invalid inputs). */
  driftPct: number;
  /** Direction: 'short' = on-chain < DB; 'over' = on-chain > DB; 'none' = no diff. */
  direction: 'short' | 'over' | 'none';
  /** Human-readable reason if valid=false. */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Pure function
// ---------------------------------------------------------------------------

/**
 * Evaluate whether a position's on-chain balance has drifted beyond threshold.
 *
 * Bug-for-bug parity with `scripts/onchain-balance.js:evaluatePositionDrift`.
 *
 * @param input.dbQty       - quantity recorded in positions.quantity
 * @param input.onchainQty  - human-readable on-chain balance
 * @param input.maxDriftPct - acceptable drift percentage (default: 1)
 * @param input.minDustQty  - dust threshold (default: 0.000001)
 */
export function evaluatePositionDrift(input: PositionDriftInput): PositionDriftResult {
  const { dbQty, onchainQty, maxDriftPct = 1, minDustQty = 0.000001 } = input;

  if (!Number.isFinite(dbQty) || dbQty < 0) {
    return { valid: false, driftPct: NaN, direction: 'none', reason: `invalid_db_qty: ${dbQty}` };
  }
  if (!Number.isFinite(onchainQty) || onchainQty < 0) {
    return { valid: false, driftPct: NaN, direction: 'none', reason: `invalid_onchain_qty: ${onchainQty}` };
  }
  // Both balances dust → not actionable.
  if (dbQty < minDustQty && onchainQty < minDustQty) {
    return { valid: true, driftPct: 0, direction: 'none' };
  }
  const denom = Math.max(dbQty, minDustQty);
  const diff = onchainQty - dbQty; // positive = on-chain has MORE than DB thinks
  const absDriftPct = (Math.abs(diff) / denom) * 100;
  const direction: 'short' | 'over' | 'none' = diff < 0 ? 'short' : diff > 0 ? 'over' : 'none';
  if (absDriftPct > maxDriftPct) {
    return {
      valid: false,
      driftPct: absDriftPct,
      direction,
      reason: `position_drift: db=${dbQty} onchain=${onchainQty} drift=${absDriftPct.toFixed(2)}% direction=${direction}`,
    };
  }
  return { valid: true, driftPct: absDriftPct, direction };
}
