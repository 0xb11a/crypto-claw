#!/usr/bin/env node
/**
 * Test Suite: CLAUDE.md ↔ chains.js Safety-Rule Drift Gate (PR 4.4)
 *
 * CLAUDE.md "Safety Rules (Do Not Weaken)" duplicates the numeric
 * portfolio limits from chains.js PORTFOLIO_RULES. If a developer
 * (or LLM) silently relaxes a limit in CLAUDE.md without touching
 * chains.js, the prose contradicts the code — agents reading
 * CLAUDE.md will plan trades the executor will reject.
 *
 * The pre-commit gate fires when either CLAUDE.md or chains.js is
 * staged. This suite tests the pure predicate against synthetic
 * CLAUDE.md fragments + PORTFOLIO_RULES objects so the logic is
 * verified independent of the live files.
 *
 * Also runs an end-to-end check against the LIVE files so any
 * existing drift surfaces immediately.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { findSafetyRuleMismatches } from '../scripts/pre-commit-check.js';
import { PORTFOLIO_RULES, getPortfolioRules } from '../scripts/chains.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const RULES_OK = {
  maxMoonshotPosition: 5,
  maxConvictionPosition: 10,
  maxBasePosition: 30,
  maxMoonshotAllocation: 30,
  minCashReserve: 10,
  maxSameNarrative: 3,
};

function buildSection(values) {
  return `# CryptoClaw

Some intro.

## Safety Rules (Do Not Weaken)

These limits are intentionally strict and must not be relaxed:

- Max moonshot position: ${values.maxMoonshotPosition}% of chain portfolio (Solana: ${values.solanaMoonshot ?? 7}% — see scripts/chains.js)
- Max conviction position: ${values.maxConvictionPosition}%
- Max base position: ${values.maxBasePosition}%
- Max total moonshot allocation: ${values.maxMoonshotAllocation}%
- Min cash reserve: ${values.minCashReserve}%
- Max same-narrative positions: ${values.maxSameNarrative}

## Some Other Section
`;
}

describe('findSafetyRuleMismatches() — happy path', () => {
  test('CLAUDE.md and chains.js fully agree → no findings', () => {
    const md = buildSection({ ...RULES_OK, solanaMoonshot: 7 });
    const findings = findSafetyRuleMismatches(md, RULES_OK, { solana: { maxMoonshotPosition: 7 } });
    assertEqual(findings.length, 0);
  });

  test('Solana override matches → no finding', () => {
    const md = buildSection({ ...RULES_OK, solanaMoonshot: 7 });
    const findings = findSafetyRuleMismatches(md, RULES_OK, { solana: { maxMoonshotPosition: 7 } });
    assertEqual(findings.length, 0);
  });
});

describe('findSafetyRuleMismatches() — value mismatch', () => {
  test('moonshot position relaxed in CLAUDE.md (5 → 10) caught', () => {
    const md = buildSection({ ...RULES_OK, maxMoonshotPosition: 10 });
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    const drift = findings.find((f) => f.rule === 'maxMoonshotPosition');
    assert(drift, 'should flag moonshot drift');
    assertEqual(drift.mdValue, 10);
    assertEqual(drift.jsValue, 5);
    assertEqual(drift.reason, 'value_mismatch');
  });

  test('cash reserve weakened in CLAUDE.md (10 → 5) caught', () => {
    const md = buildSection({ ...RULES_OK, minCashReserve: 5 });
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    assert(findings.find((f) => f.rule === 'minCashReserve'));
  });

  test('multiple drifts each reported separately', () => {
    const md = buildSection({
      ...RULES_OK,
      maxMoonshotPosition: 10,
      maxConvictionPosition: 20,
      minCashReserve: 5,
    });
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    assert(findings.length >= 3);
  });

  test('Solana override relaxed (7 → 15) caught', () => {
    const md = buildSection({ ...RULES_OK, solanaMoonshot: 15 });
    const findings = findSafetyRuleMismatches(md, RULES_OK, { solana: { maxMoonshotPosition: 7 } });
    const override = findings.find((f) => f.rule.includes('Solana'));
    assert(override, 'should flag Solana override drift');
    assertEqual(override.mdValue, 15);
    assertEqual(override.jsValue, 7);
  });

  test('chains.js raised but CLAUDE.md still old (silent re-tighten risk)', () => {
    // chains.js raised moonshot to 8%, but CLAUDE.md still says 5%.
    // If someone re-derives chains.js from CLAUDE.md prose later,
    // they'd silently tighten back to 5.
    const md = buildSection({ ...RULES_OK }); // CLAUDE.md says 5
    const newRules = { ...RULES_OK, maxMoonshotPosition: 8 };
    const findings = findSafetyRuleMismatches(md, newRules);
    assert(findings.find((f) => f.rule === 'maxMoonshotPosition'));
  });
});

describe('findSafetyRuleMismatches() — missing data', () => {
  test('Safety Rules section missing from CLAUDE.md → flagged', () => {
    const findings = findSafetyRuleMismatches('# Just an intro\n\nNo safety section.\n', RULES_OK);
    assertEqual(findings.length, 1);
    assertEqual(findings[0].reason, 'safety_rules_section_missing');
  });

  test('one phrase missing → flagged for that phrase only', () => {
    const md = `## Safety Rules (Do Not Weaken)

- Max moonshot position: 5% of chain portfolio
- Max conviction position: 10%
- Max base position: 30%
- Max total moonshot allocation: 30%
- Min cash reserve: 10%
`;
    // missing: maxSameNarrative
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    const missing = findings.filter((f) => f.reason === 'phrase_missing_in_claude_md');
    assertEqual(missing.length, 1);
    assertEqual(missing[0].rule, 'maxSameNarrative');
  });

  test('null content → unreadable_or_empty', () => {
    const findings = findSafetyRuleMismatches(null, RULES_OK);
    assertEqual(findings.length, 1);
    assertEqual(findings[0].reason, 'unreadable_or_empty');
  });

  test('empty string → unreadable_or_empty', () => {
    const findings = findSafetyRuleMismatches('', RULES_OK);
    assertEqual(findings[0].reason, 'unreadable_or_empty');
  });
});

describe('PR 4.4 — adversarial fixtures', () => {
  test('attacker silently weakens cash reserve to bypass executor cash check', () => {
    // If CLAUDE.md says 5% and chains.js still 10%, agents will
    // plan smaller cash buffers — leaving room for trades the
    // executor would reject. Drift is the warning sign.
    const md = buildSection({ ...RULES_OK, minCashReserve: 5 });
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    assert(findings.length >= 1);
  });

  test('subtle drift: 5 vs 5.0 numerically equal → no false positive', () => {
    const md = buildSection({ ...RULES_OK }).replace('5%', '5.0%');
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    // 5.0 should parseFloat to 5.0 === 5
    assertEqual(findings.length, 0);
  });

  test('decimal in CLAUDE.md vs integer in chains.js → caught', () => {
    const md = buildSection({ ...RULES_OK }).replace('Min cash reserve: 10%', 'Min cash reserve: 9.5%');
    const findings = findSafetyRuleMismatches(md, RULES_OK);
    assert(findings.find((f) => f.rule === 'minCashReserve'));
  });
});

describe('PR 4.4 — live-files smoke check', () => {
  test('shipped CLAUDE.md and shipped chains.js are in sync (no drift)', () => {
    // If this fails, CLAUDE.md or chains.js has unstaged drift that
    // the pre-commit gate would catch on the next commit. Surface it
    // in the test suite too so reviewers see it before the gate fires.
    const claudeMd = readFileSync(resolve(REPO, 'CLAUDE.md'), 'utf-8');
    const findings = findSafetyRuleMismatches(claudeMd, PORTFOLIO_RULES, {
      solana: getPortfolioRules('solana'),
    });
    if (findings.length > 0) {
      const summary = findings.map((f) => `${f.rule}: ${f.reason} (md=${f.mdValue}, js=${f.jsValue})`).join('\n  ');
      assert(false, `Live drift detected:\n  ${summary}`);
    }
    assertEqual(findings.length, 0);
  });
});

process.exit(summary() ? 0 : 1);
