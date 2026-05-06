#!/usr/bin/env node
/**
 * Test Suite: npm audit gate (PR 3.4)
 *
 * Defangs threat #21 (supply-chain attack via npm). When
 * scripts/package-lock.json mutates in a commit, pre-commit-check.js
 * runs `npm audit --json` and refuses if any high/critical
 * vulnerability exists outside the explicit AUDIT_ALLOWLIST.
 *
 * The pure predicate `findUnacceptableVulns()` is testable offline
 * with mock npm-audit JSON. The actual `npm audit` invocation is
 * exercised at commit-time only.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { findUnacceptableVulns, AUDIT_ALLOWLIST } from '../scripts/pre-commit-check.js';

function mockAudit(vulns) {
  return { auditReportVersion: 2, vulnerabilities: vulns };
}

describe('findUnacceptableVulns() — happy path', () => {
  test('clean audit returns no findings', () => {
    const out = findUnacceptableVulns(mockAudit({}));
    assertEqual(out.length, 0);
  });

  test('low/moderate findings are ignored (we only block high+critical)', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        somepkg: { severity: 'moderate', via: ['x'] },
        otherpkg: { severity: 'low', via: ['y'] },
      }),
    );
    assertEqual(out.length, 0);
  });
});

describe('findUnacceptableVulns() — flags high+critical', () => {
  test('high-severity NEW package → flagged', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        evilpkg: { severity: 'high', via: ['CVE-9999-1234'], fixAvailable: { name: 'evilpkg', version: '2.0.0' } },
      }),
    );
    assertEqual(out.length, 1);
    assertEqual(out[0].package, 'evilpkg');
    assertEqual(out[0].severity, 'high');
    assertEqual(out[0].fixAvailable, true);
  });

  test('critical-severity NEW package → flagged', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        verybadpkg: { severity: 'critical', via: ['CVE-9999-5678'] },
      }),
    );
    assertEqual(out.length, 1);
    assertEqual(out[0].severity, 'critical');
  });

  test('multiple findings all reported', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        pkg1: { severity: 'high', via: ['x'] },
        pkg2: { severity: 'critical', via: ['y'] },
        pkg3: { severity: 'low', via: ['z'] }, // ignored
      }),
    );
    assertEqual(out.length, 2);
  });
});

describe('findUnacceptableVulns() — allowlist downgrades known issues', () => {
  test('allowlisted package is NOT flagged even at high severity', () => {
    // bigint-buffer is on the AUDIT_ALLOWLIST — known transitive
    // issue we accept until @solana/spl-token publishes a fix.
    const out = findUnacceptableVulns(
      mockAudit({
        'bigint-buffer': { severity: 'high', via: ['CVE-known'] },
      }),
    );
    assertEqual(out.length, 0);
  });

  test('all four Solana chain entries are allowlisted', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        'bigint-buffer': { severity: 'high', via: [] },
        '@solana/buffer-layout-utils': { severity: 'high', via: ['bigint-buffer'] },
        '@solana/spl-token': { severity: 'high', via: ['@solana/buffer-layout-utils'] },
        '@sqds/multisig': { severity: 'high', via: ['@solana/spl-token'] },
      }),
    );
    assertEqual(out.length, 0);
  });

  test('mix: allowlisted passes, new finding still blocks', () => {
    const out = findUnacceptableVulns(
      mockAudit({
        'bigint-buffer': { severity: 'high', via: [] },
        'fresh-cve-pkg': { severity: 'high', via: ['CVE-2026-9999'] },
      }),
    );
    assertEqual(out.length, 1);
    assertEqual(out[0].package, 'fresh-cve-pkg');
  });

  test('custom allowlist overrides default', () => {
    const out = findUnacceptableVulns(mockAudit({ acceptedpkg: { severity: 'high', via: [] } }), ['acceptedpkg']);
    assertEqual(out.length, 0);
  });
});

describe('findUnacceptableVulns() — invalid input', () => {
  test('null audit object returns empty', () => {
    assertEqual(findUnacceptableVulns(null).length, 0);
  });

  test('undefined returns empty', () => {
    assertEqual(findUnacceptableVulns(undefined).length, 0);
  });

  test('audit without vulnerabilities key returns empty', () => {
    assertEqual(findUnacceptableVulns({ auditReportVersion: 2 }).length, 0);
  });

  test('vuln entry with non-object info skipped', () => {
    const out = findUnacceptableVulns(mockAudit({ pkg: 'not-an-object' }));
    assertEqual(out.length, 0);
  });
});

describe('AUDIT_ALLOWLIST contents', () => {
  test('contains the four known Solana chain packages', () => {
    assert(AUDIT_ALLOWLIST.includes('bigint-buffer'));
    assert(AUDIT_ALLOWLIST.includes('@solana/buffer-layout-utils'));
    assert(AUDIT_ALLOWLIST.includes('@solana/spl-token'));
    assert(AUDIT_ALLOWLIST.includes('@sqds/multisig'));
  });

  test('is reasonably small (allowlist drift = security drift)', () => {
    // If this grows beyond ~10 entries, something has gone wrong.
    assert(AUDIT_ALLOWLIST.length < 10, `allowlist grew to ${AUDIT_ALLOWLIST.length} entries — review`);
  });
});

describe('PR 3.4 adversarial fixtures', () => {
  test('fresh CVE in a transitive dep we never imported directly → flagged', () => {
    // Even a transitive dep at high severity blocks the commit.
    const out = findUnacceptableVulns(
      mockAudit({
        'transitive-evil': { severity: 'critical', via: ['CVE-2026-fresh'] },
      }),
    );
    assertEqual(out.length, 1);
  });

  test("exact-name match required — substring won't bypass", () => {
    // "bigint-buffer" allowlisted — but "bigint-buffer-evil" is NOT.
    const out = findUnacceptableVulns(
      mockAudit({
        'bigint-buffer-evil': { severity: 'high', via: [] },
      }),
    );
    assertEqual(out.length, 1);
  });

  test('fixAvailable flag is exposed for operator triage', () => {
    // Helpful UX: tells the operator which findings have a clean
    // upgrade path vs which need manual workaround.
    const out = findUnacceptableVulns(
      mockAudit({
        fixable: { severity: 'high', via: [], fixAvailable: { name: 'fixable', version: '2.0' } },
        unfixable: { severity: 'high', via: [] },
      }),
    );
    const fixable = out.find((o) => o.package === 'fixable');
    const unfixable = out.find((o) => o.package === 'unfixable');
    assertEqual(fixable.fixAvailable, true);
    assertEqual(unfixable.fixAvailable, false);
  });
});

process.exit(summary() ? 0 : 1);
