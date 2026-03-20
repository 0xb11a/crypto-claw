#!/usr/bin/env node
/**
 * Test Suite: Market Regime
 *
 * Tests regime classification logic, anti-whipsaw, adjustment values,
 * and the safety invariant that regime can only tighten limits.
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';
import { classifyRegime, getRegimeAdjustments, shouldTransition } from '../scripts/market-regime.js';

// ============================================================
// Hard limits from AGENTS.md — these must NEVER be relaxed
// ============================================================
const HARD_LIMITS = {
  minCashReserve: 10,
  maxMoonshotPosition: 5,
  maxConvictionPosition: 10,
  maxBasePosition: 50,
  maxMoonshotAllocation: 20,
};

// ============================================================
// Regime Classification Tests
// ============================================================
describe('Regime Classification', () => {
  test('crisis: fear < 20 AND market cap change < -5%', () => {
    assertEqual(classifyRegime(15, -7), 'crisis');
    assertEqual(classifyRegime(10, -10), 'crisis');
    assertEqual(classifyRegime(19, -5.1), 'crisis');
  });

  test('bearish: fear 20-39 AND market cap change < 0%', () => {
    assertEqual(classifyRegime(25, -2), 'bearish');
    assertEqual(classifyRegime(39, -0.1), 'bearish');
    assertEqual(classifyRegime(20, -1), 'bearish');
  });

  test('bullish: fear >= 60 AND market cap change >= 0%', () => {
    assertEqual(classifyRegime(60, 0), 'bullish');
    assertEqual(classifyRegime(80, 5), 'bullish');
    assertEqual(classifyRegime(75, 0.1), 'bullish');
  });

  test('neutral: anything else', () => {
    assertEqual(classifyRegime(50, 2), 'neutral');
    assertEqual(classifyRegime(45, -3), 'neutral');
    assertEqual(classifyRegime(55, -1), 'neutral');
  });

  test('edge: fear=19, change=-5 is NOT crisis (change must be < -5)', () => {
    assertEqual(classifyRegime(19, -5), 'bearish');
  });

  test('edge: fear=20, change=-1 is bearish (20 is in 20-39 range)', () => {
    assertEqual(classifyRegime(20, -1), 'bearish');
  });

  test('edge: fear=40, change=-1 is neutral (40 is outside 20-39)', () => {
    assertEqual(classifyRegime(40, -1), 'neutral');
  });

  test('edge: fear=59, change=0 is neutral', () => {
    assertEqual(classifyRegime(59, 0), 'neutral');
  });

  test('edge: fear=60, change=-1 is neutral (need both conditions for bullish)', () => {
    assertEqual(classifyRegime(60, -1), 'neutral');
  });
});

// ============================================================
// Regime Adjustment Tests
// ============================================================
describe('Regime Adjustments', () => {
  test('bullish adjustments match defaults', () => {
    const adj = getRegimeAdjustments('bullish');
    assertEqual(adj.regime, 'bullish');
    assertEqual(adj.minCashReserve, 10);
    assertEqual(adj.baseBuyingEnabled, true);
    assertEqual(adj.maxMoonshotPosition, 5);
    assertEqual(adj.maxConvictionPosition, 10);
    assertEqual(adj.maxBasePosition, 50);
    assertEqual(adj.maxMoonshotAllocation, 20);
    assertEqual(adj.minBuyScore, 50);
  });

  test('neutral adjustments match defaults', () => {
    const adj = getRegimeAdjustments('neutral');
    assertEqual(adj.minCashReserve, 10);
    assertEqual(adj.baseBuyingEnabled, true);
    assertEqual(adj.maxMoonshotPosition, 5);
    assertEqual(adj.maxConvictionPosition, 10);
    assertEqual(adj.maxBasePosition, 50);
  });

  test('bearish tightens limits', () => {
    const adj = getRegimeAdjustments('bearish');
    assertEqual(adj.minCashReserve, 25);
    assertEqual(adj.baseBuyingEnabled, false);
    assertEqual(adj.maxMoonshotPosition, 3);
    assertEqual(adj.maxConvictionPosition, 7);
    assertEqual(adj.maxBasePosition, 50);
    assertEqual(adj.maxMoonshotAllocation, 15);
    assertEqual(adj.minBuyScore, 65);
  });

  test('crisis tightens limits maximally', () => {
    const adj = getRegimeAdjustments('crisis');
    assertEqual(adj.minCashReserve, 40);
    assertEqual(adj.baseBuyingEnabled, false);
    assertEqual(adj.maxMoonshotPosition, 0);
    assertEqual(adj.maxConvictionPosition, 5);
    assertEqual(adj.maxBasePosition, 50);
    assertEqual(adj.maxMoonshotAllocation, 10);
    assertEqual(adj.minBuyScore, 80);
  });
});

// ============================================================
// Safety Invariant: Never Relax Hard Limits
// ============================================================
describe('Safety Invariant — Regime Never Relaxes Hard Limits', () => {
  for (const regime of ['bullish', 'neutral', 'bearish', 'crisis']) {
    test(`${regime}: minCashReserve >= ${HARD_LIMITS.minCashReserve}%`, () => {
      const adj = getRegimeAdjustments(regime);
      assert(
        adj.minCashReserve >= HARD_LIMITS.minCashReserve,
        `${regime} minCashReserve ${adj.minCashReserve}% < hard limit ${HARD_LIMITS.minCashReserve}%`,
      );
    });

    test(`${regime}: maxMoonshotPosition <= ${HARD_LIMITS.maxMoonshotPosition}%`, () => {
      const adj = getRegimeAdjustments(regime);
      assert(
        adj.maxMoonshotPosition <= HARD_LIMITS.maxMoonshotPosition,
        `${regime} maxMoonshotPosition ${adj.maxMoonshotPosition}% > hard limit ${HARD_LIMITS.maxMoonshotPosition}%`,
      );
    });

    test(`${regime}: maxConvictionPosition <= ${HARD_LIMITS.maxConvictionPosition}%`, () => {
      const adj = getRegimeAdjustments(regime);
      assert(
        adj.maxConvictionPosition <= HARD_LIMITS.maxConvictionPosition,
        `${regime} maxConvictionPosition ${adj.maxConvictionPosition}% > hard limit ${HARD_LIMITS.maxConvictionPosition}%`,
      );
    });

    test(`${regime}: maxBasePosition <= ${HARD_LIMITS.maxBasePosition}%`, () => {
      const adj = getRegimeAdjustments(regime);
      assert(
        adj.maxBasePosition <= HARD_LIMITS.maxBasePosition,
        `${regime} maxBasePosition ${adj.maxBasePosition}% > hard limit ${HARD_LIMITS.maxBasePosition}%`,
      );
    });

    test(`${regime}: maxMoonshotAllocation <= ${HARD_LIMITS.maxMoonshotAllocation}%`, () => {
      const adj = getRegimeAdjustments(regime);
      assert(
        adj.maxMoonshotAllocation <= HARD_LIMITS.maxMoonshotAllocation,
        `${regime} maxMoonshotAllocation ${adj.maxMoonshotAllocation}% > hard limit ${HARD_LIMITS.maxMoonshotAllocation}%`,
      );
    });
  }
});

// ============================================================
// Anti-Whipsaw Tests
// ============================================================
describe('Anti-Whipsaw', () => {
  test('first reading always transitions', () => {
    assert(shouldTransition('neutral', 'bearish', []), 'First reading should transition');
    assert(shouldTransition('neutral', 'bearish', null), 'Null history should transition');
  });

  test('same regime does not transition', () => {
    assert(!shouldTransition('neutral', 'neutral', [{ regime: 'neutral' }]), 'Same regime should not transition');
  });

  test('single different reading does NOT transition', () => {
    const history = [{ regime: 'neutral' }];
    assert(!shouldTransition('neutral', 'bearish', history), 'Single reading should not cause transition');
  });

  test('two consecutive same readings DOES transition', () => {
    const history = [{ regime: 'bearish' }];
    assert(
      shouldTransition('neutral', 'bearish', history),
      'Two consecutive bearish readings should transition from neutral',
    );
  });

  test('alternating readings do NOT transition', () => {
    const history = [{ regime: 'bearish' }, { regime: 'neutral' }];
    assert(!shouldTransition('neutral', 'bearish', history), 'Alternating readings should not transition');
  });

  test('transition from bearish to crisis requires confirmation', () => {
    const history = [{ regime: 'crisis' }];
    assert(shouldTransition('bearish', 'crisis', history), 'Confirmed crisis should transition');
  });

  test('recovery from crisis to neutral requires confirmation', () => {
    const history = [{ regime: 'neutral' }];
    assert(shouldTransition('crisis', 'neutral', history), 'Confirmed neutral should transition from crisis');
  });
});

// ============================================================
// Regime Strictness Ordering
// ============================================================
describe('Regime Strictness Ordering', () => {
  test('cash reserve increases with severity', () => {
    const b = getRegimeAdjustments('bullish');
    const n = getRegimeAdjustments('neutral');
    const be = getRegimeAdjustments('bearish');
    const c = getRegimeAdjustments('crisis');
    assert(b.minCashReserve <= n.minCashReserve, 'bullish <= neutral');
    assert(n.minCashReserve <= be.minCashReserve, 'neutral <= bearish');
    assert(be.minCashReserve <= c.minCashReserve, 'bearish <= crisis');
  });

  test('moonshot position limit decreases with severity', () => {
    const b = getRegimeAdjustments('bullish');
    const n = getRegimeAdjustments('neutral');
    const be = getRegimeAdjustments('bearish');
    const c = getRegimeAdjustments('crisis');
    assert(b.maxMoonshotPosition >= n.maxMoonshotPosition, 'bullish >= neutral');
    assert(n.maxMoonshotPosition >= be.maxMoonshotPosition, 'neutral >= bearish');
    assert(be.maxMoonshotPosition >= c.maxMoonshotPosition, 'bearish >= crisis');
  });

  test('conviction position limit decreases with severity', () => {
    const b = getRegimeAdjustments('bullish');
    const be = getRegimeAdjustments('bearish');
    const c = getRegimeAdjustments('crisis');
    assert(b.maxConvictionPosition >= be.maxConvictionPosition, 'bullish >= bearish');
    assert(be.maxConvictionPosition >= c.maxConvictionPosition, 'bearish >= crisis');
  });

  test('buy score threshold increases with severity', () => {
    const b = getRegimeAdjustments('bullish');
    const be = getRegimeAdjustments('bearish');
    const c = getRegimeAdjustments('crisis');
    assert(b.minBuyScore <= be.minBuyScore, 'bullish <= bearish');
    assert(be.minBuyScore <= c.minBuyScore, 'bearish <= crisis');
  });

  test('crisis disables all moonshot positions', () => {
    const c = getRegimeAdjustments('crisis');
    assertEqual(c.maxMoonshotPosition, 0);
  });

  test('bearish and crisis disable base buying', () => {
    assert(!getRegimeAdjustments('bearish').baseBuyingEnabled, 'bearish disables base buying');
    assert(!getRegimeAdjustments('crisis').baseBuyingEnabled, 'crisis disables base buying');
  });

  test('bullish and neutral enable base buying', () => {
    assert(getRegimeAdjustments('bullish').baseBuyingEnabled, 'bullish enables base buying');
    assert(getRegimeAdjustments('neutral').baseBuyingEnabled, 'neutral enables base buying');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
