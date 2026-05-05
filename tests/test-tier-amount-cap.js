#!/usr/bin/env node
/**
 * Test Suite: Tier Amount Cap (PR 2.1)
 *
 * Defangs threat #5 (cash-balance poisoning). The legacy executor only
 * checked `amount <= cash`. If portfolio_meta.cash_* is forged to e.g.
 * $1M (via prompt injection or a sync bug), then a "5% moonshot" order
 * at $50,000 passes the check — and now $50k is gone in one trade.
 *
 * PR 2.1 adds an absolute USD ceiling per tier in process-order.js
 * (BUY only — sells exit existing positions whose size was already
 * constrained at buy time). Caps live in chains.js and can be
 * overridden via env var TIER_MAX_USD_<TIER>.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { validateAmountCap } from '../scripts/process-order.js';
import { getTierMaxUsd } from '../scripts/chains.js';

const NO_OVERRIDE = {}; // empty env — use chains.js defaults

describe('getTierMaxUsd() — precedence', () => {
  test('returns chains.js default for moonshot on base', () => {
    assertEqual(getTierMaxUsd('base', 'moonshot', NO_OVERRIDE), 200);
  });

  test('returns chains.js default for conviction on base', () => {
    assertEqual(getTierMaxUsd('base', 'conviction', NO_OVERRIDE), 500);
  });

  test('returns chains.js default for base tier on base', () => {
    assertEqual(getTierMaxUsd('base', 'base', NO_OVERRIDE), 2000);
  });

  test('env var overrides chains.js default', () => {
    assertEqual(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: '500' }), 500);
  });

  test('zero/negative env value falls through to chains.js default', () => {
    assertEqual(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: '0' }), 200);
    assertEqual(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: '-100' }), 200);
  });

  test('non-numeric env value falls through', () => {
    assertEqual(getTierMaxUsd('base', 'moonshot', { TIER_MAX_USD_MOONSHOT: 'lots' }), 200);
  });

  test('returns null for unknown tier (no cap defined)', () => {
    assertEqual(getTierMaxUsd('base', 'phantom', NO_OVERRIDE), null);
  });

  test('returns null for null tier', () => {
    assertEqual(getTierMaxUsd('base', null, NO_OVERRIDE), null);
  });
});

describe('validateAmountCap() — buys are capped', () => {
  test('amount under cap passes', () => {
    const r = validateAmountCap('moonshot', 'buy', 100, 'base', NO_OVERRIDE);
    assertEqual(r.valid, true);
  });

  test('amount equal to cap passes (boundary)', () => {
    const r = validateAmountCap('moonshot', 'buy', 200, 'base', NO_OVERRIDE);
    assertEqual(r.valid, true);
  });

  test('amount over cap fails with explicit reason', () => {
    const r = validateAmountCap('moonshot', 'buy', 250, 'base', NO_OVERRIDE);
    assertEqual(r.valid, false);
    assert(r.reason.includes('250'), `reason should mention amount: ${r.reason}`);
    assert(r.reason.includes('200'), `reason should mention cap: ${r.reason}`);
    assert(r.reason.includes('moonshot'), `reason should mention tier: ${r.reason}`);
  });

  test('attacker injection of $50k moonshot is blocked', () => {
    // The cash-poisoning scenario from the threat model: agent writes
    // amount=$50,000 because cash was forged to $1M.
    const r = validateAmountCap('moonshot', 'buy', 50_000, 'base', NO_OVERRIDE);
    assertEqual(r.valid, false);
    assert(r.reason.includes('amount_over_tier_cap'));
  });

  test('conviction cap differs from moonshot', () => {
    // moonshot=200, conviction=500
    assertEqual(validateAmountCap('conviction', 'buy', 400, 'base', NO_OVERRIDE).valid, true);
    assertEqual(validateAmountCap('conviction', 'buy', 600, 'base', NO_OVERRIDE).valid, false);
    // 400 would be >moonshot cap but ok for conviction.
    assertEqual(validateAmountCap('moonshot', 'buy', 400, 'base', NO_OVERRIDE).valid, false);
  });

  test('base tier cap is highest', () => {
    assertEqual(validateAmountCap('base', 'buy', 1500, 'base', NO_OVERRIDE).valid, true);
    assertEqual(validateAmountCap('base', 'buy', 2500, 'base', NO_OVERRIDE).valid, false);
  });
});

describe('validateAmountCap() — invalid amounts', () => {
  test('null amount fails', () => {
    const r = validateAmountCap('moonshot', 'buy', null, 'base', NO_OVERRIDE);
    assertEqual(r.valid, false);
    assert(r.reason.includes('invalid_amount'));
  });

  test('negative amount fails', () => {
    assertEqual(validateAmountCap('moonshot', 'buy', -100, 'base', NO_OVERRIDE).valid, false);
  });

  test('zero amount fails', () => {
    assertEqual(validateAmountCap('moonshot', 'buy', 0, 'base', NO_OVERRIDE).valid, false);
  });

  test('NaN amount fails', () => {
    assertEqual(validateAmountCap('moonshot', 'buy', 'not-a-number', 'base', NO_OVERRIDE).valid, false);
  });

  test('numeric string is parsed', () => {
    assertEqual(validateAmountCap('moonshot', 'buy', '150', 'base', NO_OVERRIDE).valid, true);
    assertEqual(validateAmountCap('moonshot', 'buy', '300', 'base', NO_OVERRIDE).valid, false);
  });
});

describe('validateAmountCap() — sells are exempt', () => {
  test('large sell passes (sells exit existing positions)', () => {
    assertEqual(validateAmountCap('moonshot', 'sell', 100_000, 'base', NO_OVERRIDE).valid, true);
  });

  test('sell with no tier passes (sells inherit from position)', () => {
    assertEqual(validateAmountCap(null, 'sell', 100_000, 'base', NO_OVERRIDE).valid, true);
  });
});

describe('validateAmountCap() — no cap configured', () => {
  test('unknown tier returns valid (no cap to enforce)', () => {
    // When tier isn't in chains.js tierMaxUsd, getTierMaxUsd returns
    // null and the cap check is a no-op. Tier-validation (PR 1.4) is
    // the gate that catches forged tiers; the amount cap only applies
    // when there IS a configured ceiling for the tier.
    assertEqual(validateAmountCap('phantom', 'buy', 999_999, 'base', NO_OVERRIDE).valid, true);
  });
});

describe('validateAmountCap() — env var override', () => {
  test('higher env cap allows previously-blocked amount', () => {
    // Default moonshot=200, env raises to 1000.
    const env = { TIER_MAX_USD_MOONSHOT: '1000' };
    assertEqual(validateAmountCap('moonshot', 'buy', 800, 'base', env).valid, true);
    assertEqual(validateAmountCap('moonshot', 'buy', 1200, 'base', env).valid, false);
  });

  test('lower env cap blocks previously-allowed amount', () => {
    const env = { TIER_MAX_USD_MOONSHOT: '50' };
    assertEqual(validateAmountCap('moonshot', 'buy', 100, 'base', env).valid, false);
  });
});

process.exit(summary() ? 0 : 1);
