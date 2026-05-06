#!/usr/bin/env node
/**
 * Test Suite: Two-Source Data Confirmation (PR 4.2)
 *
 * Real-mode buys require BOTH DEXScreener and Birdeye to see the
 * token (and agree on price within 2%) before signing. Catches:
 *   - tokens only one source has indexed (suspicious — fresh tokens
 *     are quarantined by PR 4.1, but obscure-venue tokens slip past
 *     that)
 *   - wash-trading that inflates price on one venue but not the
 *     other (the disagreement is the signal)
 *
 * Different concern from PR 2.7's fetchOraclePrice (which validates
 * the AGGREGATOR's quote against a reference). PR 4.2 validates the
 * TOKEN ITSELF is two-source-visible.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateTwoSourceConfirmation } from '../scripts/price-oracle.js';

describe('evaluateTwoSourceConfirmation() — happy path', () => {
  test('both sources agree exactly', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.0 });
    assertEqual(r.confirmed, true);
    assertEqual(r.source, 'both');
  });

  test('1% drift passes (under default 2%)', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.01 });
    assertEqual(r.confirmed, true);
    assert(r.driftPct < 2);
  });

  test('1.9% drift passes (just under boundary)', () => {
    // Float-precision-aware: 1.02 - 1.0 in IEEE 754 is ~0.020000000000000018
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.019 });
    assertEqual(r.confirmed, true);
  });
});

describe('evaluateTwoSourceConfirmation() — single-source quarantine', () => {
  test('Birdeye-only (DEXScreener returns null) → unconfirmed', () => {
    const r = evaluateTwoSourceConfirmation({ dex: null, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'birdeye_only');
    assert(r.reason.includes('DEXScreener returned no price'));
  });

  test('DEXScreener-only (Birdeye returns null) → unconfirmed', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: null });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'dex_only');
    assert(r.reason.includes('Birdeye returned no price'));
  });

  test('both sources null → unconfirmed', () => {
    const r = evaluateTwoSourceConfirmation({ dex: null, birdeye: null });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'neither');
    assert(r.reason.includes('neither'));
  });

  test('zero price treated as null (sentinel for "no data")', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 0, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'birdeye_only');
  });

  test('NaN treated as null', () => {
    const r = evaluateTwoSourceConfirmation({ dex: NaN, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'birdeye_only');
  });

  test('negative price treated as null', () => {
    const r = evaluateTwoSourceConfirmation({ dex: -1, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
  });
});

describe('evaluateTwoSourceConfirmation() — disagreement → quarantine', () => {
  test('3% disagreement quarantines (over 2% default)', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.03 });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'both');
    assert(r.reason.includes('two_source_disagreement'));
    assert(r.reason.includes('3.00%'));
  });

  test('classic wash-trade signature: 50% drift', () => {
    // Token pumped on one DEX (DEXScreener picks up the inflated
    // price); other tracker hasn't seen the pump or has different
    // venues weighted in. 50% drift → high suspicion.
    const r = evaluateTwoSourceConfirmation({ dex: 1.5, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
    assert(r.driftPct >= 50);
  });

  test("symmetric: order doesn't matter for the verdict", () => {
    const a = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.05 });
    const b = evaluateTwoSourceConfirmation({ dex: 1.05, birdeye: 1.0 });
    assertEqual(a.confirmed, b.confirmed);
    assert(Math.abs(a.driftPct - b.driftPct) < 0.01);
  });

  test('configurable maxPriceDriftPct', () => {
    // 5% drift, default 2% → quarantine; bumped to 10% → confirmed
    assertEqual(evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.05 }).confirmed, false);
    assertEqual(evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.05, maxPriceDriftPct: 10 }).confirmed, true);
  });

  test('tighter cap (1%) catches what default would allow', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.015, maxPriceDriftPct: 1 });
    assertEqual(r.confirmed, false);
  });
});

describe('PR 4.2 adversarial fixtures', () => {
  test('fresh token (Birdeye not yet indexed): single-source unconfirmed', () => {
    // Even if PR 4.1 quarantine missed it (e.g. DEXScreener pair age
    // says >24h but Birdeye still hasn't picked up the listing),
    // PR 4.2 catches it as Birdeye-only-null.
    const r = evaluateTwoSourceConfirmation({ dex: 0.0001, birdeye: null });
    assertEqual(r.confirmed, false);
    assertEqual(r.source, 'dex_only');
  });

  test('manipulated single-DEX pump: 30% disagreement quarantines', () => {
    // Attacker spam-buys on a small DEX that DEXScreener weights
    // heavily; Birdeye's broader sample shows real price.
    const r = evaluateTwoSourceConfirmation({ dex: 1.3, birdeye: 1.0 });
    assertEqual(r.confirmed, false);
    assert(r.reason.includes('two_source_disagreement'));
  });

  test('legit small spread (1.5%): both sources agree', () => {
    // Normal stale-cache delay between sources should NOT trigger
    // quarantine.
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.015 });
    assertEqual(r.confirmed, true);
  });

  test('confirmed source is "both" only when both fetches succeed', () => {
    const r = evaluateTwoSourceConfirmation({ dex: 1.0, birdeye: 1.0 });
    assertEqual(r.source, 'both');
  });
});

process.exit(summary() ? 0 : 1);
