#!/usr/bin/env node
/**
 * Test Suite: On-Chain Cash Reconciliation (PR 2.4)
 *
 * Defangs threat #5 directly. PR 2.1 caps individual orders by tier;
 * PR 2.4 catches the upstream attack — DB cash row poisoned to
 * inflate the agent's notional bankroll. Reading the actual Safe /
 * Squads vault balance and refusing to execute on > 1% drift makes
 * it impossible to forge cash without immediately tripping the gate.
 *
 * Tests the pure predicate evaluateCashDrift(). The RPC fetch itself
 * is integration-tested (network suite) — the policy logic is here.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateCashDrift } from '../scripts/onchain-balance.js';

describe('evaluateCashDrift() — happy path', () => {
  test('exact match passes', () => {
    const r = evaluateCashDrift({ dbCash: 1000, onchainCash: 1000 });
    assertEqual(r.valid, true);
    assertEqual(r.drift, 0);
  });

  test('drift just under 1% passes', () => {
    // 1000 db, 1009 onchain → ~0.89% drift
    const r = evaluateCashDrift({ dbCash: 1000, onchainCash: 1009 });
    assertEqual(r.valid, true);
    assert(r.drift < 1, `drift ${r.drift} should be < 1`);
  });

  test('drift exactly at 1% passes (the rule is >1%)', () => {
    const r = evaluateCashDrift({ dbCash: 1010, onchainCash: 1000 });
    assertEqual(r.valid, true);
  });
});

describe('evaluateCashDrift() — drift > 1% rejected', () => {
  test('classic poisoning: db inflated $1M, onchain $5k', () => {
    const r = evaluateCashDrift({ dbCash: 1_000_000, onchainCash: 5_000 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('cash_drift_too_large'), `reason: ${r.reason}`);
    assert(r.reason.includes('1000000'), `reason should mention db amount: ${r.reason}`);
    assert(r.reason.includes('5000'), `reason should mention onchain: ${r.reason}`);
  });

  test('subtle poisoning: db $5500 vs onchain $5000 (10% drift) rejected', () => {
    const r = evaluateCashDrift({ dbCash: 5_500, onchainCash: 5_000 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('10.00%'), `reason should mention drift: ${r.reason}`);
  });

  test('underreporting also rejected (db $4500 vs onchain $5000)', () => {
    // Symmetry — abs() means underreporting fails too. Operationally
    // the executor can still sign smaller orders if cash is real, but
    // the ground-truth mismatch is the alert signal.
    const r = evaluateCashDrift({ dbCash: 4_500, onchainCash: 5_000 });
    assertEqual(r.valid, false);
  });
});

describe('evaluateCashDrift() — dust handling', () => {
  test('both balances under $5 floor passes (dust is dust)', () => {
    const r = evaluateCashDrift({ dbCash: 0.5, onchainCash: 4.0 });
    assertEqual(r.valid, true);
  });

  test('both balances at zero passes', () => {
    const r = evaluateCashDrift({ dbCash: 0, onchainCash: 0 });
    assertEqual(r.valid, true);
  });

  test('one balance above floor still triggers drift check', () => {
    // db=$10 vs onchain=$0 → 1000% drift, well above 1%, should fail
    const r = evaluateCashDrift({ dbCash: 10, onchainCash: 0 });
    assertEqual(r.valid, false);
  });

  test('configurable floor', () => {
    // Raise the floor to $100. Now dust differences below that don't trip.
    const r = evaluateCashDrift({ dbCash: 50, onchainCash: 90, minAbsoluteUsd: 100 });
    assertEqual(r.valid, true);
  });
});

describe('evaluateCashDrift() — invalid input', () => {
  test('NaN db cash rejected', () => {
    const r = evaluateCashDrift({ dbCash: NaN, onchainCash: 1000 });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_db_cash'));
  });

  test('NaN onchain rejected', () => {
    const r = evaluateCashDrift({ dbCash: 1000, onchainCash: NaN });
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_onchain_cash'));
  });

  test('negative db cash rejected', () => {
    const r = evaluateCashDrift({ dbCash: -100, onchainCash: 1000 });
    assertEqual(r.valid, false);
  });

  test('negative onchain cash rejected', () => {
    const r = evaluateCashDrift({ dbCash: 1000, onchainCash: -100 });
    assertEqual(r.valid, false);
  });
});

describe('evaluateCashDrift() — tunable maxDriftPct', () => {
  test('higher tolerance allows previously-blocked drift', () => {
    // 5% drift, but tolerance is bumped to 10%
    const r = evaluateCashDrift({ dbCash: 1050, onchainCash: 1000, maxDriftPct: 10 });
    assertEqual(r.valid, true);
  });

  test('tighter tolerance blocks previously-allowed drift', () => {
    // 0.5% drift, but tolerance dropped to 0.1%
    const r = evaluateCashDrift({ dbCash: 1005, onchainCash: 1000, maxDriftPct: 0.1 });
    assertEqual(r.valid, false);
  });
});

process.exit(summary() ? 0 : 1);
