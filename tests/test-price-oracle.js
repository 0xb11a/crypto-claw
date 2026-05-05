#!/usr/bin/env node
/**
 * Test Suite: Independent Price Oracle Cross-Check (PR 2.7)
 *
 * Defangs threat #9 (slippage check is self-referential). Before
 * PR 2.7 the executor compared the aggregator's quote to its own
 * `entry_price`, which itself came from the same DEXScreener feed
 * the agent used at proposal time. A compromised aggregator could
 * return a manipulated quote and pass the slippage cap because the
 * "expected" price was already poisoned.
 *
 * PR 2.7 cross-checks against an INDEPENDENT source at signing time.
 * Stub Pyth/Chainlink → fall back to DEXScreener + Birdeye 2-of-2
 * agreement (long-tail tokens, the realistic primary path).
 *
 * Tests the pure predicates. Network calls are integration-tested.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateTwoSourceAgreement, evaluatePriceDrift } from '../scripts/price-oracle.js';

describe('evaluateTwoSourceAgreement() — DEXScreener + Birdeye fallback', () => {
  test('exact agreement passes', () => {
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.0 });
    assertEqual(r.valid, true);
    assertEqual(r.driftPct, 0);
  });

  test('1% drift passes (under default 2% cap)', () => {
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.01 });
    assertEqual(r.valid, true);
    assert(r.driftPct < 2);
  });

  test('1.9% drift passes (just under 2% cap)', () => {
    // Float precision: avoid testing exactly-at-boundary because
    // (1.02 - 1.0) is actually 0.020000000000000018 in IEEE 754.
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.019 });
    assertEqual(r.valid, true);
  });

  test('3% disagreement REJECTED — at least one source wrong', () => {
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.03 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('two_source_disagreement'));
    assert(r.reason.includes('3.00%'));
  });

  test('massive disagreement (10x) REJECTED', () => {
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 10.0 });
    assertEqual(r.valid, false);
  });

  test('order-independent (a vs b same as b vs a)', () => {
    const r1 = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.05 });
    const r2 = evaluateTwoSourceAgreement({ priceA: 1.05, priceB: 1.0 });
    assertEqual(r1.valid, r2.valid);
    assert(Math.abs(r1.driftPct - r2.driftPct) < 0.01);
  });

  test('configurable agreement cap', () => {
    // 5% drift, default cap 2 → fails. Bumped cap to 10 → passes.
    assertEqual(evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.05 }).valid, false);
    assertEqual(evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.05, maxAgreementPct: 10 }).valid, true);
  });

  test('invalid input fails (negative price)', () => {
    const r = evaluateTwoSourceAgreement({ priceA: -1, priceB: 1 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_price_a'));
  });

  test('zero price fails', () => {
    assertEqual(evaluateTwoSourceAgreement({ priceA: 0, priceB: 1 }).valid, false);
    assertEqual(evaluateTwoSourceAgreement({ priceA: 1, priceB: 0 }).valid, false);
  });

  test('NaN price fails', () => {
    assertEqual(evaluateTwoSourceAgreement({ priceA: NaN, priceB: 1 }).valid, false);
  });
});

describe('evaluatePriceDrift() — quote vs oracle', () => {
  test('exact match passes', () => {
    const r = evaluatePriceDrift({ quotePrice: 1.0, oraclePrice: 1.0 });
    assertEqual(r.valid, true);
    assertEqual(r.driftPct, 0);
  });

  test('3% drift passes (under default 5% cap)', () => {
    const r = evaluatePriceDrift({ quotePrice: 1.03, oraclePrice: 1.0 });
    assertEqual(r.valid, true);
  });

  test('4.9% drift passes (just under 5% cap)', () => {
    // Float precision: 1.05 - 1.0 in IEEE 754 = 0.05000000000000004,
    // which trips the strict > 5 check at the exact boundary.
    const r = evaluatePriceDrift({ quotePrice: 1.049, oraclePrice: 1.0 });
    assertEqual(r.valid, true);
  });

  test('5.1% drift FAILS', () => {
    const r = evaluatePriceDrift({ quotePrice: 1.051, oraclePrice: 1.0 });
    assertEqual(r.valid, false);
  });

  test('aggregator quote 50% above oracle (manipulated quote) FAILS', () => {
    const r = evaluatePriceDrift({ quotePrice: 1.5, oraclePrice: 1.0 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('quote_oracle_drift'));
    assert(r.reason.includes('50.00%'));
  });

  test('aggregator quote 50% BELOW oracle (sandwich beyond cap) FAILS', () => {
    // Quote says we get $0.5 per token but oracle says $1 — we're
    // about to hugely overpay. Same drift threshold catches both
    // directions of mismatch.
    const r = evaluatePriceDrift({ quotePrice: 0.5, oraclePrice: 1.0 });
    assertEqual(r.valid, false);
  });

  test('configurable maxDriftPct', () => {
    // 8% drift, default cap 5 → fails. Bumped cap to 10 → passes.
    assertEqual(evaluatePriceDrift({ quotePrice: 1.08, oraclePrice: 1.0 }).valid, false);
    assertEqual(evaluatePriceDrift({ quotePrice: 1.08, oraclePrice: 1.0, maxDriftPct: 10 }).valid, true);
  });

  test('invalid quote fails', () => {
    const r = evaluatePriceDrift({ quotePrice: -1, oraclePrice: 1 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_quote_price'));
  });

  test('invalid oracle fails', () => {
    const r = evaluatePriceDrift({ quotePrice: 1, oraclePrice: 0 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_oracle_price'));
  });
});

describe('PR 2.7 realistic adversarial fixtures', () => {
  test('compromised 1inch returns 30% inflated quote — caught', () => {
    // Attacker quote says "you get 1.30 tokens for $1" but oracle
    // average says "real price is 1.0 token per $1". 30% drift fails.
    const r = evaluatePriceDrift({ quotePrice: 1.3, oraclePrice: 1.0 });
    assertEqual(r.valid, false);
  });

  test('legitimate small spread (DEXScreener vs Birdeye 1.5% apart)', () => {
    // Common: stale cache on one side, recent print on the other.
    const r = evaluateTwoSourceAgreement({ priceA: 1.0, priceB: 1.015 });
    assertEqual(r.valid, true);
  });

  test('long-tail token where Birdeye returns null → no fallback price', () => {
    // The orchestrating fetchOraclePrice() returns null in this case
    // (tested via integration). The predicates here just verify that
    // we don't try to compute drift with bad input.
    const r = evaluateTwoSourceAgreement({ priceA: 1, priceB: null });
    assertEqual(r.valid, false);
  });
});

process.exit(summary() ? 0 : 1);
