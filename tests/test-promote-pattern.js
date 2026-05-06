#!/usr/bin/env node
/**
 * Test Suite: promote-pattern.js + MEMORY.md write protection (PR 3.1)
 *
 * Defangs threat #27 (memory poisoning). MEMORY.md is loaded by all
 * four agents on every cycle — a single malicious "pattern" promoted
 * via prompt injection is a persistent backdoor across all agents
 * and all future cycles.
 *
 * promote-pattern.js validates inputs and emits a provenance marker.
 * pre-commit-check.js refuses MEMORY.md edits without that marker.
 * Both halves are tested below.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import {
  parseDerivedFrom,
  validateDerivedFromShape,
  validateSeenCount,
  validateAttestation,
} from '../scripts/promote-pattern.js';
import { findMissingMemoryTrails } from '../scripts/pre-commit-check.js';

describe('parseDerivedFrom() — string parsing', () => {
  test('parses single id', () => {
    const out = parseDerivedFrom('receipt:abc-123');
    assertEqual(out.length, 1);
    assertEqual(out[0].type, 'receipt');
    assertEqual(out[0].id, 'abc-123');
  });

  test('parses comma-separated list', () => {
    const out = parseDerivedFrom('receipt:abc,alert:def,position:ghi');
    assertEqual(out.length, 3);
    assertEqual(out[1].type, 'alert');
    assertEqual(out[2].id, 'ghi');
  });

  test('strips whitespace', () => {
    const out = parseDerivedFrom('receipt:abc , alert:def');
    assertEqual(out.length, 2);
    assertEqual(out[0].id, 'abc');
    assertEqual(out[1].type, 'alert');
  });

  test('empty string returns empty array', () => {
    assertEqual(parseDerivedFrom('').length, 0);
    assertEqual(parseDerivedFrom(null).length, 0);
  });

  test('id without prefix has empty type', () => {
    const out = parseDerivedFrom('orphan-id');
    assertEqual(out[0].type, '');
    assertEqual(out[0].id, 'orphan-id');
  });
});

describe('validateDerivedFromShape() — must trace to trusted sources', () => {
  test('valid receipt id passes shape check', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('receipt:rcpt-abc-123'));
    assertEqual(r.valid, true);
  });

  test('multiple valid sources pass', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('receipt:abc,alert:def,position:ghi'));
    assertEqual(r.valid, true);
  });

  test('untrusted source REJECTED (e.g. tracked_wallets)', () => {
    // tracked_wallets has free-text notes that could be agent-poisoned.
    const r = validateDerivedFromShape(parseDerivedFrom('tracked_wallets:abc'));
    assertEqual(r.valid, false);
    assert(r.reason.includes('untrusted_source'), r.reason);
  });

  test('untrusted source REJECTED (orders.reasoning)', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('order:abc'));
    assertEqual(r.valid, false);
    assert(r.reason.includes('untrusted_source'));
  });

  test('untrusted source REJECTED (analysis_cache — agent-typed token data)', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('analysis_cache:abc'));
    assertEqual(r.valid, false);
  });

  test('id without prefix REJECTED', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('orphan-id-no-prefix'));
    assertEqual(r.valid, false);
    assert(r.reason.includes('missing_type'));
  });

  test('one good + one bad → REJECT (whole derived-from must be valid)', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('receipt:abc,tracked_wallets:def'));
    assertEqual(r.valid, false);
  });

  test('empty derived-from REJECTED (must have provenance)', () => {
    assertEqual(validateDerivedFromShape([]).valid, false);
  });

  test('id too short REJECTED', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('receipt:ab'));
    assertEqual(r.valid, false);
    assert(r.reason.includes('bad_id'));
  });

  test('id too long REJECTED (DOS / spam)', () => {
    const r = validateDerivedFromShape(parseDerivedFrom('receipt:' + 'x'.repeat(200)));
    assertEqual(r.valid, false);
  });
});

describe('validateSeenCount() — minimum 3 occurrences', () => {
  test('seen=3 passes (the boundary)', () => {
    const r = validateSeenCount('3');
    assertEqual(r.valid, true);
    assertEqual(r.seen, 3);
  });

  test('seen=10 passes', () => {
    assertEqual(validateSeenCount('10').valid, true);
  });

  test('seen=2 REJECTED — below minimum', () => {
    const r = validateSeenCount('2');
    assertEqual(r.valid, false);
    assert(r.reason.includes('below_minimum'));
  });

  test('seen=1 REJECTED', () => {
    assertEqual(validateSeenCount('1').valid, false);
  });

  test('seen=0 REJECTED', () => {
    assertEqual(validateSeenCount('0').valid, false);
  });

  test('non-numeric REJECTED', () => {
    assertEqual(validateSeenCount('many').valid, false);
  });

  test('negative REJECTED', () => {
    assertEqual(validateSeenCount('-5').valid, false);
  });
});

describe('validateAttestation() — known skill set', () => {
  test('risk allowed', () => {
    assertEqual(validateAttestation('risk').valid, true);
  });

  test('analyst allowed', () => {
    assertEqual(validateAttestation('analyst').valid, true);
  });

  test('observer allowed', () => {
    assertEqual(validateAttestation('observer').valid, true);
  });

  test('executor allowed (rare but supported)', () => {
    assertEqual(validateAttestation('executor').valid, true);
  });

  test('manual allowed (operator-driven)', () => {
    assertEqual(validateAttestation('manual').valid, true);
  });

  test('unknown source REJECTED', () => {
    const r = validateAttestation('llm_decided_to_promote');
    assertEqual(r.valid, false);
    assert(r.reason.includes('not_allowed'));
  });

  test('empty REJECTED', () => {
    assertEqual(validateAttestation('').valid, false);
  });

  test('null REJECTED', () => {
    assertEqual(validateAttestation(null).valid, false);
  });

  test('attempted injection REJECTED', () => {
    assertEqual(validateAttestation('risk; cat /etc/passwd').valid, false);
  });
});

describe('findMissingMemoryTrails() — pre-commit gate', () => {
  function makeDiff({ file = 'workspace/MEMORY.md', addedLines = [], hunkStart = 100 }) {
    const lines = [
      `diff --git a/${file} b/${file}`,
      `--- a/${file}`,
      `+++ b/${file}`,
      `@@ -${hunkStart},0 +${hunkStart},${addedLines.length} @@`,
      ...addedLines.map((l) => '+' + l),
    ];
    return lines.join('\n');
  }

  test('valid pattern WITH marker passes', () => {
    const diff = makeDiff({
      addedLines: [
        '<!-- via promote-pattern.js attestation=risk derived_from=receipt:abc seen=3 ts=2026-05-05 -->',
        '### Late-night liquidity rugs (seen: 3 times)',
        '- Description: ...',
      ],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 0);
  });

  test('manual pattern WITHOUT marker → flagged', () => {
    const diff = makeDiff({
      addedLines: ['### Sneaky injected pattern (seen: 5 times)', '- Description: BACKDOOR'],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 1);
    assertEqual(findings[0].rule, 'memory-pattern-without-trail');
  });

  test('multiple patterns each need a marker', () => {
    const diff = makeDiff({
      addedLines: [
        '<!-- via promote-pattern.js attestation=risk -->',
        '### Pattern A (seen: 3 times)',
        '- ...',
        '',
        '### Pattern B WITHOUT marker (seen: 4 times)',
        '- ...',
      ],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 1);
    assert(findings[0].snippet.includes('Pattern B'));
  });

  test('non-MEMORY.md files are ignored', () => {
    const diff = makeDiff({
      file: 'workspace/USER.md',
      addedLines: ['### Some heading without marker'],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 0);
  });

  test('template entries (### [Pattern Name]) are ignored', () => {
    const diff = makeDiff({
      addedLines: ['### [Pattern Name] (confidence: X%, seen: N times)'],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 0);
  });

  test('marker on the same line counts (loose match)', () => {
    const diff = makeDiff({
      addedLines: [
        '<!-- via promote-pattern.js attestation=observer derived_from=observer_log:abc seen=3 ts=2026-05-05 -->',
        '### Observer-detected pattern (seen: 3)',
      ],
    });
    const findings = findMissingMemoryTrails(diff);
    assertEqual(findings.length, 0);
  });

  test('empty diff passes', () => {
    assertEqual(findMissingMemoryTrails('').length, 0);
  });
});

describe('PR 3.1 adversarial fixtures', () => {
  test('classic injection: agent invents a pattern from a poisoned token name', () => {
    // The pattern name itself looks fine, but the derived-from points
    // to no trusted source. Shape check rejects.
    const r = validateDerivedFromShape(parseDerivedFrom('tracked_wallets:abc'));
    assertEqual(r.valid, false);
  });

  test('attempted bypass: spoofed marker via free-form text in pattern body', () => {
    // Even if the pattern body contains the string "via promote-
    // pattern.js" inside it, the shape check on derived-from is what
    // matters at the script layer. At the pre-commit layer, the
    // marker just needs to appear within the look-back window of
    // the new H3 — so this is a known limitation we accept (a true
    // attacker who can write to MEMORY.md can already write the
    // string verbatim). The runtime promote-pattern.js validation
    // is the real gate.
    const diff = [
      'diff --git a/workspace/MEMORY.md b/workspace/MEMORY.md',
      '--- a/workspace/MEMORY.md',
      '+++ b/workspace/MEMORY.md',
      '@@ -100,0 +100,2 @@',
      '+<!-- via promote-pattern.js spoofed -->',
      '+### Spoofed pattern (seen: 99)',
    ].join('\n');
    const findings = findMissingMemoryTrails(diff);
    // The pre-commit only checks structural presence of marker. We
    // explicitly accept this gap — the runtime script check is the
    // hard gate.
    assertEqual(findings.length, 0);
  });
});

process.exit(summary() ? 0 : 1);
