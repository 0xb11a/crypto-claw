#!/usr/bin/env node
/**
 * Test Suite: Pre-Sign Safety Re-check (PR 2.2)
 *
 * The Research agent validates safety at proposal time. PR 2.2 adds
 * a SECOND safety check inside process-order.js immediately before
 * signing — so a token that turns malicious after Research's check
 * (or after a slow approval) is still caught at the moment of value
 * movement. Defense in depth.
 *
 * Hard-rejects: honeypot, transfer_pausable, top-holder > 30%,
 * liquidity < $5k. Plus a fail-closed catch-all for malformed /
 * missing data from either subprocess.
 *
 * This suite tests the pure predicate evaluateRecheck() with mocked
 * inputs. The end-to-end spawn integration is covered indirectly by
 * the network suite (test-process-order.js).
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { evaluateRecheck } from '../scripts/process-order.js';

// Minimal "safe token" check-contract.js output used as a happy-path
// baseline. Tests mutate one field at a time to assert the predicate
// catches the threat.
const SAFE_CONTRACT = {
  status: 'ok',
  safety: {
    isHoneypot: false,
    canPause: false,
    hasBlacklist: false,
    isMintable: false,
    buyTax: 0,
    sellTax: 0,
  },
  holders: {
    count: 1500,
    topHolders: [
      { address: '0xabc', percent: '12.50', isContract: false, isLocked: false },
      { address: '0xdef', percent: '8.20', isContract: false, isLocked: false },
    ],
  },
  flags: [],
  riskScore: 5,
  autoReject: false,
  verdict: 'LOW_RISK',
};

describe('evaluateRecheck() — happy path', () => {
  test('clean token + healthy liquidity passes', () => {
    const r = evaluateRecheck({ liquidity: 50_000, safety: SAFE_CONTRACT });
    assertEqual(r.valid, true);
  });

  test('boundary: liquidity exactly at $5k passes', () => {
    const r = evaluateRecheck({ liquidity: 5_000, safety: SAFE_CONTRACT });
    assertEqual(r.valid, true);
  });

  test('boundary: top holder exactly at 30% passes (the rule is >30%)', () => {
    const safety = {
      ...SAFE_CONTRACT,
      holders: { count: 100, topHolders: [{ address: '0xabc', percent: '30.00', isContract: false, isLocked: false }] },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, true);
  });
});

describe('evaluateRecheck() — hard rejects', () => {
  test('honeypot rejected', () => {
    const safety = { ...SAFE_CONTRACT, safety: { ...SAFE_CONTRACT.safety, isHoneypot: true } };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
    assert(r.reason.includes('honeypot'), `reason: ${r.reason}`);
  });

  test('pausable rejected', () => {
    const safety = { ...SAFE_CONTRACT, safety: { ...SAFE_CONTRACT.safety, canPause: true } };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
    assert(r.reason.includes('pausable'), `reason: ${r.reason}`);
  });

  test('top holder > 30% rejected', () => {
    const safety = {
      ...SAFE_CONTRACT,
      holders: { count: 100, topHolders: [{ address: '0xabc', percent: '45.50', isContract: false, isLocked: false }] },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
    assert(r.reason.includes('top_holder_too_high'), `reason: ${r.reason}`);
    assert(r.reason.includes('45'), `reason should include actual pct: ${r.reason}`);
  });

  test('liquidity rugged (below $5k) rejected', () => {
    const r = evaluateRecheck({ liquidity: 1_500, safety: SAFE_CONTRACT });
    assertEqual(r.valid, false);
    assert(r.reason.includes('liquidity_too_low_at_signing'), `reason: ${r.reason}`);
  });

  test('check-contract autoReject=true rejected even if individual fields look ok', () => {
    const safety = {
      ...SAFE_CONTRACT,
      autoReject: true,
      flags: [{ type: 'mystery_critical_flag', severity: 'critical', description: 'x' }],
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
    assert(r.reason.includes('autoReject_at_signing'), `reason: ${r.reason}`);
    assert(r.reason.includes('mystery_critical_flag'), `reason should include the flag type: ${r.reason}`);
  });

  test('verdict=REJECT rejected', () => {
    const safety = { ...SAFE_CONTRACT, verdict: 'REJECT' };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
  });
});

describe('evaluateRecheck() — top-holder edge cases', () => {
  test('legitimate LP lock (isLocked=true) at 60% does NOT count as top holder', () => {
    // Many tokens have their LP locked at >50%. That's the safe
    // pattern, not a rugpull risk — the recheck should ignore locked
    // holders when computing the "real" top.
    const safety = {
      ...SAFE_CONTRACT,
      holders: {
        count: 100,
        topHolders: [
          { address: '0xLP', percent: '60.00', isContract: true, isLocked: true },
          { address: '0xnext', percent: '5.00', isContract: false, isLocked: false },
        ],
      },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, true);
  });

  test('contract holder (e.g. multisig vault) does NOT count', () => {
    const safety = {
      ...SAFE_CONTRACT,
      holders: {
        count: 100,
        topHolders: [
          { address: '0xCONTRACT', percent: '40.00', isContract: true, isLocked: false },
          { address: '0xnext', percent: '5.00', isContract: false, isLocked: false },
        ],
      },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, true);
  });

  test('first NON-locked NON-contract holder at 35% is rejected', () => {
    const safety = {
      ...SAFE_CONTRACT,
      holders: {
        count: 100,
        topHolders: [
          { address: '0xLP', percent: '60.00', isContract: true, isLocked: true },
          { address: '0xWHALE', percent: '35.00', isContract: false, isLocked: false },
        ],
      },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, false);
    assert(r.reason.includes('top_holder_too_high'));
  });

  test('empty holders array passes (no whales to worry about)', () => {
    const safety = { ...SAFE_CONTRACT, holders: { count: 0, topHolders: [] } };
    const r = evaluateRecheck({ liquidity: 50_000, safety });
    assertEqual(r.valid, true);
  });
});

describe('evaluateRecheck() — fail-closed on malformed input', () => {
  test('null liquidity fails', () => {
    const r = evaluateRecheck({ liquidity: null, safety: SAFE_CONTRACT });
    assertEqual(r.valid, false);
    assert(r.reason.includes('recheck_failed'));
  });

  test('NaN liquidity fails', () => {
    const r = evaluateRecheck({ liquidity: NaN, safety: SAFE_CONTRACT });
    assertEqual(r.valid, false);
  });

  test('null safety object fails', () => {
    const r = evaluateRecheck({ liquidity: 50_000, safety: null });
    assertEqual(r.valid, false);
    assert(r.reason.includes('recheck_failed'));
  });

  test('missing safety.safety nested object — handled gracefully', () => {
    // check-contract.js sometimes returns status='not_found' with no
    // safety nesting. Should not throw, should fall through to OK
    // (because the explicit honeypot/pausable bits are absent — the
    // operator-side prose-rule still gates this elsewhere).
    const r = evaluateRecheck({ liquidity: 50_000, safety: { status: 'not_found' } });
    // Empty safety nesting means we can't assert it's UNSAFE — fall
    // through to the autoReject catch-all which is also absent. So
    // technically valid. This is the trade-off documented in the
    // helper: real outages should use SKIP_PRESIGN_RECHECK rather
    // than relying on graceful pass-through.
    assertEqual(r.valid, true);
  });
});

describe('evaluateRecheck() — configurable thresholds', () => {
  test('higher minLiquidity blocks previously-passing token', () => {
    const r = evaluateRecheck({ liquidity: 6_000, safety: SAFE_CONTRACT, minLiquidity: 10_000 });
    assertEqual(r.valid, false);
  });

  test('higher maxTopHolderPct allows previously-blocked token', () => {
    const safety = {
      ...SAFE_CONTRACT,
      holders: { count: 100, topHolders: [{ address: '0xabc', percent: '40.00', isContract: false, isLocked: false }] },
    };
    const r = evaluateRecheck({ liquidity: 50_000, safety, maxTopHolderPct: 50 });
    assertEqual(r.valid, true);
  });
});

process.exit(summary() ? 0 : 1);
