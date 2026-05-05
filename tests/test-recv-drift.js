#!/usr/bin/env node
/**
 * Test Suite: Post-Swap Received-Drift Predicate (PR 2.6)
 *
 * Defangs threat #16 (fee-on-transfer / partial honeypot). Before
 * PR 2.6 the executor wrote position.quantity from the quote, not
 * the actual on-chain delta — a 1% transfer-fee token would silently
 * leave the position 1% short. Sentinel's stop-loss math then
 * operates on stale qty, slowly bleeding capital across many
 * positions before anyone notices.
 *
 * PR 2.6:
 *   - executor reads pre/post balance, returns actualReceived
 *   - process-order.js uses actualReceived for position.quantity
 *   - if drift > maxSlippage + 0.5%, fires a critical alert and
 *     writes a marker into positions.notes
 *
 * This suite tests the pure drift predicate. The pre/post snapshot
 * itself is integration-tested via the network suite.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateReceivedDrift } from '../scripts/onchain-balance.js';

describe('evaluateReceivedDrift() — happy path', () => {
  test('exact match passes', () => {
    const r = evaluateReceivedDrift({ actualReceived: 100, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, true);
    assertEqual(r.driftPct, 0);
  });

  test('received MORE than quoted (positive surprise) passes', () => {
    // Aggregator gave a conservative quote, real execution beat it.
    const r = evaluateReceivedDrift({ actualReceived: 105, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, true);
    assertEqual(r.driftPct, 0); // negative drift clamped to 0
  });

  test('drift just under slippage cap passes', () => {
    // 4% short, cap is 5% slippage + 0.5% tolerance = 5.5%.
    const r = evaluateReceivedDrift({ actualReceived: 96, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, true);
    assert(r.driftPct < 5.5);
  });

  test('drift exactly at cap passes (rule is strict >)', () => {
    // 5.5% short = cap exactly.
    const r = evaluateReceivedDrift({ actualReceived: 94.5, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, true);
  });
});

describe('evaluateReceivedDrift() — drift exceeded → fail', () => {
  test('1% fee-on-transfer with conviction tier (2% slippage) — over cap', () => {
    // Conviction cap = 2% + 0.5% = 2.5%. A 1% fee tax shows up as 1%
    // shortfall — under cap, OK. Test the 3% case which should fail.
    const r = evaluateReceivedDrift({ actualReceived: 97, quotedReceived: 100, maxSlippagePct: 2 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('received_short'));
    assert(r.reason.includes('3.00%'));
  });

  test('classic 10% fee-on-transfer (any tier, way over cap)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 90, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
    assert(r.driftPct > 9 && r.driftPct < 11);
  });

  test('partial honeypot (only 50% of expected received)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 50, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
    assert(r.driftPct >= 50);
  });

  test('drift just over moonshot cap (5.6% short, cap=5.5%)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 94.4, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
  });

  test('drift just over conviction cap (2.6% short, cap=2.5%)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 97.4, quotedReceived: 100, maxSlippagePct: 2 });
    assertEqual(r.valid, false);
  });
});

describe('evaluateReceivedDrift() — extra tolerance is configurable', () => {
  test('tighter extra tolerance catches what default would miss', () => {
    // Default tolerance = 0.5%. With extraTolerancePct=0, 5.1% drift fails.
    const r = evaluateReceivedDrift({
      actualReceived: 94.9,
      quotedReceived: 100,
      maxSlippagePct: 5,
      extraTolerancePct: 0,
    });
    assertEqual(r.valid, false);
  });

  test('looser extra tolerance allows previously-failing drift', () => {
    const r = evaluateReceivedDrift({
      actualReceived: 90,
      quotedReceived: 100,
      maxSlippagePct: 5,
      extraTolerancePct: 10, // total cap 15%
    });
    assertEqual(r.valid, true);
  });
});

describe('evaluateReceivedDrift() — invalid input', () => {
  test('negative actualReceived rejected', () => {
    const r = evaluateReceivedDrift({ actualReceived: -10, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_actual_received'));
  });

  test('NaN actualReceived rejected', () => {
    const r = evaluateReceivedDrift({ actualReceived: NaN, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
  });

  test('zero quotedReceived rejected (would divide by zero)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 0, quotedReceived: 0, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_quoted_received'));
  });

  test('negative slippage rejected', () => {
    const r = evaluateReceivedDrift({ actualReceived: 100, quotedReceived: 100, maxSlippagePct: -1 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_max_slippage_pct'));
  });
});

describe('evaluateReceivedDrift() — realistic adversarial fixtures', () => {
  test('SafeMoon-style 5% transfer tax on a moonshot (5% slippage)', () => {
    // 5% tax + small price wiggle = ~6% short. Cap = 5.5%. Fails.
    const r = evaluateReceivedDrift({ actualReceived: 94, quotedReceived: 100, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
  });

  test('non-tax token at 0.1% drift (normal) passes for any tier', () => {
    const r = evaluateReceivedDrift({ actualReceived: 99.9, quotedReceived: 100, maxSlippagePct: 2 });
    assertEqual(r.valid, true);
  });

  test('huge sell ($10k → ~$9500 received with 5% sandwich attack)', () => {
    // Sandwich within slippage cap = legitimate, no flag.
    const r = evaluateReceivedDrift({ actualReceived: 9500, quotedReceived: 10000, maxSlippagePct: 5 });
    assertEqual(r.valid, true); // 5% drift, cap is 5.5%
  });

  test('huge sell with 6% sandwich (just past cap)', () => {
    const r = evaluateReceivedDrift({ actualReceived: 9400, quotedReceived: 10000, maxSlippagePct: 5 });
    assertEqual(r.valid, false);
  });
});

process.exit(summary() ? 0 : 1);
