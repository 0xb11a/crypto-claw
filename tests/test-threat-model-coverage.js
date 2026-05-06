#!/usr/bin/env node
/**
 * Test Suite: THREAT_MODEL.md coverage (PR 4.5)
 *
 * docs/THREAT_MODEL.md is onboarding material — it must reference
 * every shipped security-hardening PR so future contributors can
 * trace each mitigation back to the code. If a new PR ships without
 * updating this doc, the system grows defenses no one knows about.
 *
 * The check is loose: "PR X.Y" must appear somewhere in the doc.
 * Wording can change; the citation is the load-bearing thing.
 */

import { describe, test, assert, summary } from './test-helpers.js';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');
const DOC = resolve(REPO, 'docs/THREAT_MODEL.md');

// Every PR that shipped a code-level mitigation must be cited.
// Update this list when adding a new hardening PR.
const REQUIRED_PR_CITATIONS = [
  'PR 1.1', // sanitizeUntrusted
  'PR 1.2', // sanitizer wiring
  'PR 1.3', // address-validator
  'PR 1.4', // tier validation
  'PR 1.5', // AUTO_APPROVE_BUY hardening
  'PR 1.6', // untrusted-strings principle
  'PR 2.1', // tier amount cap
  'PR 2.2', // pre-sign safety recheck
  'PR 2.3', // aggregator allowlist
  'PR 2.4', // cash reconciliation
  'PR 2.5', // scoped approvals
  'PR 2.6', // post-swap balance
  'PR 2.7', // price oracle
  'PR 2.8', // RPC allowlist
  'PR 3.1', // promote-pattern.js
  'PR 3.2', // governance drift
  'PR 3.3', // position reconcile
  'PR 3.4', // npm audit gate
  'PR 4.1', // quarantine tier
  'PR 4.2', // two-source confirm
  'PR 4.4', // CLAUDE.md drift gate
];

// Each test suite that backs a mitigation should be referenced too,
// so the doc tells the reader where to look to verify.
const REQUIRED_TEST_SUITES = [
  'tests/test-redact.js',
  'tests/test-address-validator.js',
  'tests/test-tier-validation.js',
  'tests/test-auto-approve-cap.js',
  'tests/test-untrusted-rule.js',
  'tests/test-tier-amount-cap.js',
  'tests/test-presign-recheck.js',
  'tests/test-aggregator-allowlist.js',
  'tests/test-cash-reconcile.js',
  'tests/test-scoped-approvals.js',
  'tests/test-recv-drift.js',
  'tests/test-price-oracle.js',
  'tests/test-rpc-allowlist.js',
  'tests/test-promote-pattern.js',
  'tests/test-governance-drift.js',
  'tests/test-position-reconcile.js',
  'tests/test-audit-gate.js',
  'tests/test-quarantine-age.js',
  'tests/test-two-source-confirm.js',
  'tests/test-safety-rule-drift.js',
];

describe('THREAT_MODEL.md exists and is reachable', () => {
  test('docs/THREAT_MODEL.md file exists', () => {
    assert(existsSync(DOC), 'docs/THREAT_MODEL.md must exist (PR 4.5)');
  });

  test('docs/THREAT_MODEL.md is non-trivial (> 50 lines)', () => {
    const content = readFileSync(DOC, 'utf-8');
    const lines = content.split('\n').length;
    assert(lines > 50, `THREAT_MODEL.md should be substantive; got ${lines} lines`);
  });

  test('docs/THREAT_MODEL.md is not unbounded (< 400 lines — onboarding material)', () => {
    const content = readFileSync(DOC, 'utf-8');
    const lines = content.split('\n').length;
    assert(lines < 400, `THREAT_MODEL.md is onboarding material; ${lines} lines is too long to scan`);
  });
});

describe('THREAT_MODEL.md cites every shipped hardening PR', () => {
  // Read once outside the per-test loop to avoid 21 file reads.
  const content = existsSync(DOC) ? readFileSync(DOC, 'utf-8') : '';

  for (const pr of REQUIRED_PR_CITATIONS) {
    test(`mentions ${pr}`, () => {
      assert(
        content.includes(pr),
        `THREAT_MODEL.md should cite ${pr} so contributors can trace its mitigation. Missing.`,
      );
    });
  }
});

describe('THREAT_MODEL.md points at test suites for verification', () => {
  const content = existsSync(DOC) ? readFileSync(DOC, 'utf-8') : '';

  for (const suite of REQUIRED_TEST_SUITES) {
    test(`references ${suite}`, () => {
      // Loose match — full path or just basename
      const basename = suite.split('/').pop();
      const found = content.includes(suite) || content.includes(basename);
      assert(found, `THREAT_MODEL.md should reference ${suite} (or ${basename}) as the verification path`);
    });
  }
});

describe('THREAT_MODEL.md covers the mandatory sections', () => {
  const content = existsSync(DOC) ? readFileSync(DOC, 'utf-8') : '';

  test('has a section listing N/A vectors (architecture-eliminated)', () => {
    assert(/N\/A|don't apply/i.test(content), 'should have a "N/A" / "don\'t apply" section');
  });

  test('has a section listing accepted residuals', () => {
    assert(/accepted residual|accepted/i.test(content), 'should document intentionally-accepted risks');
  });

  test('has a "verify all mitigations" section', () => {
    assert(/verify|make test|make audit|make check/i.test(content), 'should tell the reader how to verify');
  });

  test('has a "when to update" section', () => {
    assert(/when to update|update this doc/i.test(content), 'should specify when contributors must update the doc');
  });
});

process.exit(summary() ? 0 : 1);
