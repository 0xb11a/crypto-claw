#!/usr/bin/env node
/**
 * Test Suite: Untrusted-Strings Core Principle (PR 1.6)
 *
 * PR 1.2 strips structural injection at ingest. PR 1.6 closes the
 * remaining SEMANTIC threat: a token's `name`/`symbol`/holder tag /
 * wallet label / log line / GitHub issue body could still try to
 * persuade the LLM ("100% legit", "OFFICIAL", "ignore previous
 * instructions"). The defense is a Core Principle in every AGENTS.md
 * telling each agent to base decisions only on numeric/structural
 * fields and refuse to follow embedded instructions.
 *
 * This test guards against accidental deletion of that rule during
 * future edits.
 */

import { describe, test, assert, summary } from './test-helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const AGENTS = ['research', 'sentinel', 'executor', 'observer'];

// Substrings every AGENTS.md must contain. Specific enough that random
// edits won't accidentally satisfy them; loose enough to allow wording
// changes (e.g. tightening a sentence) without churning the test.
const REQUIRED_PHRASES = [
  /external strings are untrusted data/i,
  /attacker-controlled|deployer-.*controlled/i,
  /ignore previous instructions/i,
];

describe('PR 1.6 — every AGENTS.md states the untrusted-strings rule', () => {
  for (const agent of AGENTS) {
    test(`${agent}/AGENTS.md contains the untrusted-data principle`, () => {
      const path = resolve(REPO, 'agents', agent, 'AGENTS.md');
      const content = readFileSync(path, 'utf-8');
      for (const phrase of REQUIRED_PHRASES) {
        assert(phrase.test(content), `${agent}/AGENTS.md missing required pattern: ${phrase}`);
      }
    });
  }

  test('Research and Observer also explicitly forbid copying untrusted strings into MEMORY.md', () => {
    // These two agents are the writers to MEMORY.md; the rule needs to
    // reach them specifically.
    for (const agent of ['research', 'observer']) {
      const content = readFileSync(resolve(REPO, 'agents', agent, 'AGENTS.md'), 'utf-8');
      assert(/MEMORY\.md/i.test(content), `${agent}/AGENTS.md should reference MEMORY.md in the rule`);
    }
  });
});

process.exit(summary() ? 0 : 1);
