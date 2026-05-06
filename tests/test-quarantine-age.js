#!/usr/bin/env node
/**
 * Test Suite: Token-Age Quarantine (PR 4.1)
 *
 * Real-mode buys for tokens younger than chains.js
 * `quarantineTokenAgeHours` (default 24h) get refused. Defangs the
 * highest scam-risk window — rugpulls and post-launch contract
 * upgrades cluster in the first 24h after listing.
 *
 * Operator can manually override (via `approve-order` after
 * re-evaluation) or disable fund-wide via QUARANTINE_TOKEN_AGE_HOURS=0.
 * Paper mode skips entirely.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateTokenAge } from '../scripts/process-order.js';
import { getQuarantineTokenAgeHours } from '../scripts/chains.js';

const NOW = new Date('2026-05-06T12:00:00Z');
const HOUR = 3_600_000;

describe('getQuarantineTokenAgeHours() — precedence', () => {
  test('returns chains.js default (24) when no env override', () => {
    assertEqual(getQuarantineTokenAgeHours('base', {}), 24);
  });

  test('env var overrides default', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '48' }), 48);
  });

  test('env=0 disables quarantine (operator opt-out)', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '0' }), 0);
  });

  test('env=12 tightens to half a day', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '12' }), 12);
  });

  test('negative env value falls through to default', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '-5' }), 24);
  });

  test('non-numeric env value falls through to default', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: 'forever' }), 24);
  });

  test('empty string env falls through to default (operator forgot to set)', () => {
    assertEqual(getQuarantineTokenAgeHours('base', { QUARANTINE_TOKEN_AGE_HOURS: '' }), 24);
  });
});

describe('evaluateTokenAge() — happy path', () => {
  test('25h-old token passes 24h gate', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 25 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, true);
    assert(r.ageHours > 24);
  });

  test('1-week-old token passes', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 7 * 24 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, true);
  });

  test('quarantine disabled (minAgeHours=0) passes any age', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 1 * HOUR).toISOString(),
      minAgeHours: 0,
      currentTime: NOW,
    });
    assertEqual(r.valid, true);
  });
});

describe('evaluateTokenAge() — quarantined', () => {
  test('1h-old token blocked by 24h gate', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 1 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
    assert(r.reason.includes('quarantined_age'));
    assert(r.reason.includes('1.0h'));
    assert(r.reason.includes('24h'));
  });

  test('23h59m-old token still blocked (boundary)', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 23.99 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
  });

  test('fresh-listing token (5 min old) blocked', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 5 * 60 * 1000).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
  });

  test('tighter 48h gate blocks a 30h token', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 30 * HOUR).toISOString(),
      minAgeHours: 48,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
  });

  test('relaxed 12h gate allows a 13h token', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 13 * HOUR).toISOString(),
      minAgeHours: 12,
      currentTime: NOW,
    });
    assertEqual(r.valid, true);
  });
});

describe('evaluateTokenAge() — fail-open on missing data', () => {
  test('null pairCreatedAt → valid (fail open, recheck handled structural)', () => {
    const r = evaluateTokenAge({ pairCreatedAt: null, minAgeHours: 24, currentTime: NOW });
    assertEqual(r.valid, true);
    assertEqual(r.ageHours, null);
  });

  test('undefined pairCreatedAt → valid', () => {
    assertEqual(evaluateTokenAge({ pairCreatedAt: undefined, minAgeHours: 24 }).valid, true);
  });

  test('empty string pairCreatedAt → valid', () => {
    assertEqual(evaluateTokenAge({ pairCreatedAt: '', minAgeHours: 24 }).valid, true);
  });

  test('unparseable date → valid (fail open)', () => {
    assertEqual(evaluateTokenAge({ pairCreatedAt: 'not-a-date', minAgeHours: 24 }).valid, true);
  });
});

describe('evaluateTokenAge() — input formats', () => {
  test('accepts ISO string', () => {
    assertEqual(
      evaluateTokenAge({
        pairCreatedAt: '2026-05-04T12:00:00Z',
        minAgeHours: 24,
        currentTime: NOW,
      }).valid,
      true,
    );
  });

  test('accepts epoch ms (number)', () => {
    assertEqual(
      evaluateTokenAge({
        pairCreatedAt: NOW.getTime() - 50 * HOUR,
        minAgeHours: 24,
        currentTime: NOW,
      }).valid,
      true,
    );
  });

  test('accepts Date object', () => {
    assertEqual(
      evaluateTokenAge({
        pairCreatedAt: new Date(NOW.getTime() - 50 * HOUR),
        minAgeHours: 24,
        currentTime: NOW,
      }).valid,
      true,
    );
  });
});

describe('evaluateTokenAge() — adversarial fixtures', () => {
  test('future-dated pairCreatedAt → quarantined (suspicious data)', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() + 10 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
    assert(r.reason.includes('future'));
  });

  test('classic 2-hour rugpull window — blocked', () => {
    // Token deployed 2h ago, pumping → typical rugpull setup.
    // Quarantine refuses to commit real capital.
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 2 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, false);
  });

  test('exactly 24h passes (just over the boundary)', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 24 * HOUR - 1).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    assertEqual(r.valid, true);
  });

  test('exactly at boundary (24.0h) passes (rule is strict <)', () => {
    const r = evaluateTokenAge({
      pairCreatedAt: new Date(NOW.getTime() - 24 * HOUR).toISOString(),
      minAgeHours: 24,
      currentTime: NOW,
    });
    // ageHours === 24, rule is `< minAgeHours` (24 not < 24)
    assertEqual(r.valid, true);
  });
});

process.exit(summary() ? 0 : 1);
