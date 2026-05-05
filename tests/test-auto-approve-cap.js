#!/usr/bin/env node
/**
 * Test Suite: AUTO_APPROVE_BUY Cap Enforcement (PR 1.5)
 *
 * Defangs threat #30 (AUTO_APPROVE_BUY=true + prompt-injected
 * Research → unbounded buy at attacker CA). The hardening:
 *   - AUTO_APPROVE_BUY only takes effect when AUTO_APPROVE_BUY_MAX_USD
 *     is configured to a positive value
 *   - Even with the cap configured, orders > cap downgrade to pending
 *     with a `downgradedReason` so the operator sees why
 *   - The entrypoint refuses to start if cap missing — this suite
 *     tests the in-process defense-in-depth path inside db-query.js
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { determineOrderApproval } from '../scripts/order-approval.js';

const REAL_AUTO = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true', AUTO_APPROVE_BUY_MAX_USD: '50' };
const REAL_NO_AUTO = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'false' };
const PAPER = { PAPER_MODE: 'true', AUTO_APPROVE_BUY: 'false' };

describe('paper mode — always paper_mode-approved (cap irrelevant)', () => {
  test('large amount auto-approves in paper', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 1_000_000 }, PAPER);
    assertEqual(r.status, 'approved');
    assertEqual(r.approvedBy, 'paper_mode');
    assertEqual(r.downgradedReason, null);
  });
});

describe('real mode + AUTO_APPROVE_BUY=false — pending', () => {
  test('any buy goes to pending', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 10 }, REAL_NO_AUTO);
    assertEqual(r.status, 'pending');
    assertEqual(r.approvedBy, null);
    assertEqual(r.downgradedReason, null);
  });
});

describe('real mode + AUTO_APPROVE_BUY=true + cap configured — bounded auto', () => {
  test('amount under cap auto-approves', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 25 }, REAL_AUTO);
    assertEqual(r.status, 'approved');
    assertEqual(r.approvedBy, 'auto');
    assertEqual(r.downgradedReason, null);
  });

  test('amount equal to cap auto-approves (boundary)', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 50 }, REAL_AUTO);
    assertEqual(r.status, 'approved');
  });

  test('amount over cap downgrades to pending', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 51 }, REAL_AUTO);
    assertEqual(r.status, 'pending');
    assertEqual(r.approvedBy, null);
    assert(r.downgradedReason.includes('51'), `reason should mention amount: ${r.downgradedReason}`);
    assert(r.downgradedReason.includes('50'), `reason should mention cap: ${r.downgradedReason}`);
  });

  test('amount string is parsed', () => {
    const r = determineOrderApproval({ action: 'buy', amount: '25.5' }, REAL_AUTO);
    assertEqual(r.status, 'approved');
  });

  test('huge amount (attacker injection) downgrades, not silently approved', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 1_000_000 }, REAL_AUTO);
    assertEqual(r.status, 'pending');
    assert(r.downgradedReason.includes('exceeds'), `reason: ${r.downgradedReason}`);
  });
});

describe('real mode + AUTO_APPROVE_BUY=true + cap MISSING — defense in depth', () => {
  test('missing AUTO_APPROVE_BUY_MAX_USD downgrades all auto-buys', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true' };
    const r = determineOrderApproval({ action: 'buy', amount: 1 }, env);
    assertEqual(r.status, 'pending');
    assertEqual(r.approvedBy, null);
    assert(r.downgradedReason.includes('AUTO_APPROVE_BUY_MAX_USD'), `reason: ${r.downgradedReason}`);
  });

  test('cap=0 also downgrades', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true', AUTO_APPROVE_BUY_MAX_USD: '0' };
    const r = determineOrderApproval({ action: 'buy', amount: 1 }, env);
    assertEqual(r.status, 'pending');
  });

  test('negative cap downgrades', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true', AUTO_APPROVE_BUY_MAX_USD: '-50' };
    const r = determineOrderApproval({ action: 'buy', amount: 1 }, env);
    assertEqual(r.status, 'pending');
  });

  test('non-numeric cap downgrades', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true', AUTO_APPROVE_BUY_MAX_USD: 'lots' };
    const r = determineOrderApproval({ action: 'buy', amount: 1 }, env);
    assertEqual(r.status, 'pending');
  });

  test('empty-string cap downgrades', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true', AUTO_APPROVE_BUY_MAX_USD: '' };
    const r = determineOrderApproval({ action: 'buy', amount: 1 }, env);
    assertEqual(r.status, 'pending');
  });
});

describe('invalid/poisoned amount values', () => {
  test('null amount downgrades', () => {
    const r = determineOrderApproval({ action: 'buy', amount: null }, REAL_AUTO);
    assertEqual(r.status, 'pending');
    assert(r.downgradedReason.includes('invalid amount'), `reason: ${r.downgradedReason}`);
  });

  test('negative amount downgrades', () => {
    const r = determineOrderApproval({ action: 'buy', amount: -100 }, REAL_AUTO);
    assertEqual(r.status, 'pending');
  });

  test('zero amount downgrades', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 0 }, REAL_AUTO);
    assertEqual(r.status, 'pending');
  });

  test('NaN amount downgrades', () => {
    const r = determineOrderApproval({ action: 'buy', amount: 'not-a-number' }, REAL_AUTO);
    assertEqual(r.status, 'pending');
  });
});

describe('sells unaffected by cap', () => {
  test('large sell still sentinel-approved', () => {
    const r = determineOrderApproval({ action: 'sell', amount: 1_000_000 }, REAL_AUTO);
    assertEqual(r.status, 'approved');
    assertEqual(r.approvedBy, 'sentinel');
    assertEqual(r.downgradedReason, null);
  });

  test('sell with no cap configured still works', () => {
    const env = { PAPER_MODE: 'false', AUTO_APPROVE_BUY: 'true' };
    const r = determineOrderApproval({ action: 'sell', amount: 100 }, env);
    assertEqual(r.status, 'approved');
    assertEqual(r.approvedBy, 'sentinel');
  });
});

process.exit(summary() ? 0 : 1);
