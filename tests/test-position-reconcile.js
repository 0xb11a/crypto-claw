#!/usr/bin/env node
/**
 * Test Suite: Position On-Chain Reconciliation Predicate (PR 3.3)
 *
 * Defense in depth on top of PR 2.6. PR 2.6 catches drift at the
 * moment of buy. PR 3.3 catches drift that emerges AFTER the buy:
 *   - Continuous fee-on-transfer / rebase tokens slowly draining
 *   - Solana freeze authority confiscating the position
 *   - Backdoor mint diluting our holdings
 *   - DB sync bugs
 *
 * Sentinel doesn't auto-sell on detection (the damage is done by the
 * time we notice). Operator-decided exit.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluatePositionDrift } from '../scripts/onchain-balance.js';

describe('evaluatePositionDrift() — happy path', () => {
  test('exact match passes', () => {
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 1000 });
    assertEqual(r.valid, true);
    assertEqual(r.driftPct, 0);
    assertEqual(r.direction, 'none');
  });

  test('drift just under 1% passes', () => {
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 1009 });
    assertEqual(r.valid, true);
    assert(r.driftPct < 1);
  });

  test('drift exactly at 1% passes (rule is strict >)', () => {
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 1010 });
    assertEqual(r.valid, true);
  });
});

describe('evaluatePositionDrift() — drift exceeded → flag', () => {
  test('classic continuous fee-on-transfer (5% drained over time)', () => {
    // We bought 1000 tokens; over time the 1% transfer tax + DEX
    // interactions shaved 5% off our holdings.
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 950 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('position_drift'));
    assertEqual(r.direction, 'short');
  });

  test('Solana freeze authority confiscation (entire position gone)', () => {
    const r = evaluatePositionDrift({ dbQty: 1_000_000, onchainQty: 0 });
    assertEqual(r.valid, false);
    assert(Math.abs(r.driftPct - 100) < 0.1);
    assertEqual(r.direction, 'short');
  });

  test('backdoor mint diluted our share (we have MORE than expected — direction=over)', () => {
    // Less common but still drift: someone minted into our wallet
    // (airdrop) or our DB undercounted at buy time.
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 1100 });
    assertEqual(r.valid, false);
    assertEqual(r.direction, 'over');
  });

  test('drift just over 1% fails', () => {
    // 1.5% short, cap is 1%
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 985 });
    assertEqual(r.valid, false);
  });
});

describe('evaluatePositionDrift() — dust handling', () => {
  test('both balances dust passes (closed-position artifact)', () => {
    const r = evaluatePositionDrift({ dbQty: 0, onchainQty: 0.0000001 });
    assertEqual(r.valid, true);
  });

  test('one balance above dust still triggers check', () => {
    const r = evaluatePositionDrift({ dbQty: 100, onchainQty: 0 });
    assertEqual(r.valid, false);
  });
});

describe('evaluatePositionDrift() — invalid input', () => {
  test('NaN dbQty rejected', () => {
    const r = evaluatePositionDrift({ dbQty: NaN, onchainQty: 100 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_db_qty'));
  });

  test('NaN onchainQty rejected', () => {
    const r = evaluatePositionDrift({ dbQty: 100, onchainQty: NaN });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_onchain_qty'));
  });

  test('negative dbQty rejected', () => {
    const r = evaluatePositionDrift({ dbQty: -100, onchainQty: 100 });
    assertEqual(r.valid, false);
  });

  test('negative onchainQty rejected', () => {
    const r = evaluatePositionDrift({ dbQty: 100, onchainQty: -100 });
    assertEqual(r.valid, false);
  });
});

describe('evaluatePositionDrift() — configurable thresholds', () => {
  test('higher tolerance allows previously-blocked drift', () => {
    // 5% drift, but tolerance bumped to 10%
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 950, maxDriftPct: 10 });
    assertEqual(r.valid, true);
  });

  test('tighter tolerance blocks previously-allowed drift', () => {
    // 0.5% drift, tolerance dropped to 0.1%
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 1005, maxDriftPct: 0.1 });
    assertEqual(r.valid, false);
  });

  test('configurable dust floor', () => {
    // db=10, onchain=15 → 50% drift in normal terms. But if we set a
    // high dust floor, both fall under it and check passes.
    const r = evaluatePositionDrift({ dbQty: 10, onchainQty: 15, minDustQty: 100 });
    assertEqual(r.valid, true);
  });
});

describe('PR 3.3 adversarial fixtures', () => {
  test('SafeMoon-style 5% transfer tax accumulates over weeks', () => {
    // Even if PR 2.6 caught the FIRST 5%, weeks of compounding tx
    // taxes erode further. Each reconcile pass detects the gap.
    const r = evaluatePositionDrift({ dbQty: 100_000, onchainQty: 90_000 });
    assertEqual(r.valid, false);
    assertEqual(r.direction, 'short');
  });

  test('honeypot reveals on attempted transfer (full position locked)', () => {
    // Some honeypots only reveal when the position tries to move.
    // The vault still HAS the tokens but they're un-sellable. Drift
    // shows 0 only if the tokens were burned/clawed back; but locked
    // tokens still appear in balance, so this test models the case
    // where backdoor MINT diluted the supply and the holder %
    // dropped — onchainQty unchanged but the position's effective
    // value tanked. (This is detected by liquidity check, not here.)
    const r = evaluatePositionDrift({ dbQty: 1_000_000, onchainQty: 1_000_000 });
    assertEqual(r.valid, true);
  });

  test('dev mints 100x supply — our position appears larger by dilution', () => {
    // If the dev mints 100x supply into our wallet (an airdrop trap
    // to dilute us off-chain), we have MORE tokens but each is
    // worth less. Direction=over. Operator decides.
    const r = evaluatePositionDrift({ dbQty: 1000, onchainQty: 100_000 });
    assertEqual(r.valid, false);
    assertEqual(r.direction, 'over');
  });
});

process.exit(summary() ? 0 : 1);
