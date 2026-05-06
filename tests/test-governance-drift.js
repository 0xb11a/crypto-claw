#!/usr/bin/env node
/**
 * Test Suite: Governance Drift Detection (PR 3.2)
 *
 * Defangs threat #18 (multisig owner / threshold drift). A silent
 * governance attack is the highest-leverage compromise possible:
 * adding an attacker-controlled owner or lowering the threshold to
 * 1 doesn't drain anything immediately — it grants permanent
 * unilateral control. The next "legitimate" transaction is the
 * drain.
 *
 * The pure predicates here are wired into check-safe-status.js and
 * check-squads-status.js (--check-drift flag), invoked daily by
 * run_governance_drift_loop in entrypoint.sh.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import {
  evaluateSafeDrift,
  evaluateSquadsDrift,
  readExpectedSafeConfig,
  readExpectedSquadsConfig,
} from '../scripts/governance-drift.js';

const OWNER_A = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OWNER_B = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const OWNER_C = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const ATTACKER = '0xEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';

describe('readExpectedSafeConfig() — env parsing', () => {
  test('reads owners + threshold + modules from env', () => {
    const env = {
      EXPECTED_SAFE_OWNERS_BASE: `${OWNER_A},${OWNER_B}`,
      EXPECTED_SAFE_THRESHOLD_BASE: '2',
      EXPECTED_SAFE_MODULES_BASE: '',
    };
    const cfg = readExpectedSafeConfig('base', env);
    assertEqual(cfg.owners.size, 2);
    assertEqual(cfg.threshold, 2);
    assertEqual(cfg.modules.size, 0);
    assertEqual(cfg.hasExpectations, true);
  });

  test('lowercases owner addresses for case-insensitive comparison', () => {
    const env = { EXPECTED_SAFE_OWNERS_BASE: OWNER_A.toUpperCase() };
    const cfg = readExpectedSafeConfig('base', env);
    assert(cfg.owners.has(OWNER_A.toLowerCase()));
  });

  test('hasExpectations false when no env vars set', () => {
    const cfg = readExpectedSafeConfig('base', {});
    assertEqual(cfg.hasExpectations, false);
  });

  test('chain name uppercased for env lookup', () => {
    const env = { EXPECTED_SAFE_OWNERS_ETHEREUM: OWNER_A };
    const cfg = readExpectedSafeConfig('ethereum', env);
    assertEqual(cfg.owners.size, 1);
  });
});

describe('evaluateSafeDrift() — happy path', () => {
  function expected(owners = [OWNER_A, OWNER_B, OWNER_C], threshold = 2, modules = []) {
    return {
      owners: new Set(owners.map((o) => o.toLowerCase())),
      threshold,
      modules: new Set(modules.map((m) => m.toLowerCase())),
      hasExpectations: true,
    };
  }

  test('matching config passes', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 2,
      observedModules: [],
      expected: expected(),
    });
    assertEqual(r.valid, true);
    assertEqual(r.alerts.length, 0);
  });

  test('case-insensitive owner match', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A.toLowerCase(), OWNER_B.toLowerCase(), OWNER_C.toLowerCase()],
      observedThreshold: 2,
      observedModules: [],
      expected: expected(),
    });
    assertEqual(r.valid, true);
  });

  test('owner order doesnt matter', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_C, OWNER_A, OWNER_B],
      observedThreshold: 2,
      expected: expected(),
    });
    assertEqual(r.valid, true);
  });

  test('skips check entirely when no expected config set', () => {
    const r = evaluateSafeDrift({
      observedOwners: [ATTACKER],
      observedThreshold: 1,
      observedModules: [],
      expected: { owners: new Set(), threshold: null, modules: new Set(), hasExpectations: false },
    });
    assertEqual(r.valid, true);
    assertEqual(r.skipped, 'no_expected_config_set');
  });
});

describe('evaluateSafeDrift() — owner attacks', () => {
  function expected() {
    return {
      owners: new Set([OWNER_A, OWNER_B, OWNER_C].map((o) => o.toLowerCase())),
      threshold: 2,
      modules: new Set(),
      hasExpectations: true,
    };
  }

  test('attacker owner ADDED → critical alert', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C, ATTACKER],
      observedThreshold: 2,
      observedModules: [],
      expected: expected(),
    });
    assertEqual(r.valid, false);
    const alert = r.alerts.find((a) => a.type === 'owner_added');
    assert(alert);
    assertEqual(alert.severity, 'critical');
    assert(alert.detail.toLowerCase().includes(ATTACKER.toLowerCase()));
  });

  test('legitimate owner REMOVED → critical alert', () => {
    // Could be social-engineered legit owner removal — still drift.
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B], // C missing
      observedThreshold: 2,
      observedModules: [],
      expected: expected(),
    });
    assertEqual(r.valid, false);
    const alert = r.alerts.find((a) => a.type === 'owner_removed');
    assert(alert);
    assertEqual(alert.severity, 'critical');
  });

  test('owner swap (legit removed, attacker added) → BOTH alerts', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, ATTACKER], // C swapped for ATTACKER
      observedThreshold: 2,
      observedModules: [],
      expected: expected(),
    });
    assertEqual(r.valid, false);
    assert(r.alerts.find((a) => a.type === 'owner_added'));
    assert(r.alerts.find((a) => a.type === 'owner_removed'));
  });
});

describe('evaluateSafeDrift() — threshold attacks', () => {
  function expected(threshold) {
    return {
      owners: new Set([OWNER_A, OWNER_B, OWNER_C].map((o) => o.toLowerCase())),
      threshold,
      modules: new Set(),
      hasExpectations: true,
    };
  }

  test('threshold lowered (2 → 1) → critical alert', () => {
    // The classic governance hijack — drop threshold to 1 then any
    // owner can drain unilaterally.
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 1,
      observedModules: [],
      expected: expected(2),
    });
    assertEqual(r.valid, false);
    const alert = r.alerts.find((a) => a.type === 'threshold_lowered');
    assert(alert);
    assertEqual(alert.severity, 'critical');
    assert(alert.detail.includes('observed=1'));
    assert(alert.detail.includes('expected=2'));
  });

  test('threshold raised (2 → 3) → high alert (not critical, but drift)', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 3,
      observedModules: [],
      expected: expected(2),
    });
    assertEqual(r.valid, false);
    const alert = r.alerts.find((a) => a.type === 'threshold_changed');
    assert(alert);
    assertEqual(alert.severity, 'high');
  });

  test('threshold not configured → skipped', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 1,
      observedModules: [],
      expected: { ...expected(2), threshold: null },
    });
    assertEqual(r.valid, true);
  });

  test('non-numeric observed threshold → critical', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 'oops',
      observedModules: [],
      expected: expected(2),
    });
    assertEqual(r.valid, false);
    assert(r.alerts.find((a) => a.type === 'threshold_unparseable'));
  });
});

describe('evaluateSafeDrift() — module attacks', () => {
  function expected(modules = []) {
    return {
      owners: new Set([OWNER_A, OWNER_B].map((o) => o.toLowerCase())),
      threshold: 2,
      modules: new Set(modules.map((m) => m.toLowerCase())),
      hasExpectations: true,
    };
  }

  test('unexpected module enabled → critical alert', () => {
    // Safe modules can execute txs without going through the multisig
    // — adding one is equivalent to lowering threshold to 1.
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B],
      observedThreshold: 2,
      observedModules: [ATTACKER],
      expected: expected([]),
    });
    assertEqual(r.valid, false);
    const alert = r.alerts.find((a) => a.type === 'module_unexpected');
    assert(alert);
    assertEqual(alert.severity, 'critical');
  });

  test('expected module passes', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B],
      observedThreshold: 2,
      observedModules: [OWNER_A],
      expected: expected([OWNER_A]),
    });
    assertEqual(r.valid, true);
  });
});

describe('evaluateSquadsDrift() — Solana Squads', () => {
  const MEM_A = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const MEM_B = 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
  const MEM_C = 'CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
  const SOL_ATTACKER = 'EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE';

  function expected(members = [MEM_A, MEM_B, MEM_C], threshold = 2) {
    return {
      members: new Set(members),
      threshold,
      hasExpectations: true,
    };
  }

  test('matching members + threshold passes', () => {
    const r = evaluateSquadsDrift({
      observedMembers: [MEM_A, MEM_B, MEM_C],
      observedThreshold: 2,
      expected: expected(),
    });
    assertEqual(r.valid, true);
  });

  test('attacker member added → critical alert', () => {
    const r = evaluateSquadsDrift({
      observedMembers: [MEM_A, MEM_B, MEM_C, SOL_ATTACKER],
      observedThreshold: 2,
      expected: expected(),
    });
    assertEqual(r.valid, false);
    assert(r.alerts.find((a) => a.type === 'member_added'));
  });

  test('threshold lowered → critical alert', () => {
    const r = evaluateSquadsDrift({
      observedMembers: [MEM_A, MEM_B, MEM_C],
      observedThreshold: 1,
      expected: expected(),
    });
    assertEqual(r.valid, false);
    assert(r.alerts.find((a) => a.type === 'threshold_lowered'));
  });

  test('case-sensitive comparison (Solana base58)', () => {
    // Different from EVM: pubkey case matters.
    const r = evaluateSquadsDrift({
      observedMembers: [MEM_A.toLowerCase(), MEM_B, MEM_C],
      observedThreshold: 2,
      expected: expected(),
    });
    assertEqual(r.valid, false);
  });

  test('readExpectedSquadsConfig parses env', () => {
    const env = {
      EXPECTED_SQUADS_MEMBERS: `${MEM_A},${MEM_B}`,
      EXPECTED_SQUADS_THRESHOLD: '2',
    };
    const cfg = readExpectedSquadsConfig(env);
    assertEqual(cfg.members.size, 2);
    assertEqual(cfg.threshold, 2);
    assertEqual(cfg.hasExpectations, true);
  });
});

describe('PR 3.2 adversarial fixtures', () => {
  test('classic compromise: attacker added + threshold lowered to 1', () => {
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C, ATTACKER],
      observedThreshold: 1,
      observedModules: [],
      expected: {
        owners: new Set([OWNER_A, OWNER_B, OWNER_C].map((o) => o.toLowerCase())),
        threshold: 2,
        modules: new Set(),
        hasExpectations: true,
      },
    });
    assertEqual(r.valid, false);
    assert(r.alerts.length >= 2);
    assert(r.alerts.find((a) => a.type === 'owner_added'));
    assert(r.alerts.find((a) => a.type === 'threshold_lowered'));
  });

  test('subtle attack: malicious module enabled, owners untouched', () => {
    // Owner-add is conspicuous; module-add is the subtler hijack
    // because the owner list LOOKS clean. The check catches it.
    const r = evaluateSafeDrift({
      observedOwners: [OWNER_A, OWNER_B, OWNER_C],
      observedThreshold: 2,
      observedModules: [ATTACKER], // the attacker contract
      expected: {
        owners: new Set([OWNER_A, OWNER_B, OWNER_C].map((o) => o.toLowerCase())),
        threshold: 2,
        modules: new Set(),
        hasExpectations: true,
      },
    });
    assertEqual(r.valid, false);
    assert(r.alerts.find((a) => a.type === 'module_unexpected'));
  });
});

process.exit(summary() ? 0 : 1);
