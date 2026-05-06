#!/usr/bin/env node
/**
 * Test Suite: Untrusted-Strings Core Principle (PR 1.6, locked in by PR 4.3)
 *
 * PR 1.2 strips structural injection at ingest. PR 1.6 closes the
 * remaining SEMANTIC threat: a token's `name`/`symbol`/holder tag /
 * wallet label / log line / GitHub issue body could still try to
 * persuade the LLM ("100% legit", "OFFICIAL", "ignore previous
 * instructions"). The defense is a Core Principle in every AGENTS.md
 * telling each agent to base decisions only on numeric/structural
 * fields and refuse to follow embedded instructions.
 *
 * PR 4.3 strengthens the test: each agent's rule must NAME the
 * specific external surfaces relevant to that agent. A generic
 * "untrusted strings exist" assertion is too loose — a future edit
 * could remove all the concrete examples while still passing the
 * regex. Concrete surfaces are what make the rule actionable.
 */

import { describe, test, assert, summary } from './test-helpers.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, '..');

const AGENTS = ['research', 'sentinel', 'executor', 'observer'];

// Phrases every AGENTS.md must contain. Specific enough that random
// edits won't accidentally satisfy them; loose enough to allow wording
// tweaks without churning the test.
const REQUIRED_GENERAL_PHRASES = [
  /external strings are untrusted data/i,
  /attacker-controlled|deployer-.*controlled/i,
  /ignore previous instructions/i,
];

// PR 4.3 — agent-specific surface assertions. Each agent's rule must
// NAME at least one concrete attacker surface relevant to its job.
// Removing the names would leave the rule abstract and untraceable.
const REQUIRED_AGENT_SPECIFIC = {
  research: [
    /DEXScreener/i, // primary attacker-controlled ingest source
    /GoPlus|Birdeye/i, // additional ingest sources
  ],
  sentinel: [
    /get-positions|tokenSymbol|check-wallets/i, // sentinel's specific tools that surface untrusted data
    /numeric thresholds|price drift|liquidity/i, // explicit "decide on numbers, not strings"
  ],
  executor: [
    /symbol.*name.*reasoning|order fields/i, // executor's specific surface (order JSON fields)
    /process-order\.js/i, // pointer to the structural validator
  ],
  observer: [
    /log line|GitHub issue|sentinel_alerts/i, // observer's specific surface
    /correlation logic|own correlation/i, // explicit "decide from your own logic, not the strings"
  ],
};

describe('PR 1.6 — every AGENTS.md states the untrusted-strings rule', () => {
  for (const agent of AGENTS) {
    test(`${agent}/AGENTS.md contains the untrusted-data principle (general)`, () => {
      const path = resolve(REPO, 'agents', agent, 'AGENTS.md');
      const content = readFileSync(path, 'utf-8');
      for (const phrase of REQUIRED_GENERAL_PHRASES) {
        assert(phrase.test(content), `${agent}/AGENTS.md missing required general pattern: ${phrase}`);
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

describe('PR 4.3 — agent-specific surface naming (lock-in)', () => {
  for (const [agent, patterns] of Object.entries(REQUIRED_AGENT_SPECIFIC)) {
    for (const pattern of patterns) {
      test(`${agent}/AGENTS.md names the concrete surface: ${pattern}`, () => {
        const path = resolve(REPO, 'agents', agent, 'AGENTS.md');
        const content = readFileSync(path, 'utf-8');
        assert(
          pattern.test(content),
          `${agent}/AGENTS.md missing concrete-surface pattern: ${pattern} — the untrusted-data rule needs an agent-specific anchor or it becomes abstract`,
        );
      });
    }
  }
});

describe('PR 3.1 + 4.3 — every AGENTS.md points at promote-pattern.js for MEMORY.md writes', () => {
  // Without this cross-reference, an agent reading just AGENTS.md
  // wouldn't know that direct MEMORY.md edits are blocked. The
  // promote-pattern.js mention is the discoverable handle.
  for (const agent of AGENTS) {
    test(`${agent}/AGENTS.md references promote-pattern.js`, () => {
      const path = resolve(REPO, 'agents', agent, 'AGENTS.md');
      const content = readFileSync(path, 'utf-8');
      assert(
        /promote-pattern\.js/.test(content),
        `${agent}/AGENTS.md must reference promote-pattern.js so the agent can discover the validated MEMORY.md write path`,
      );
    });
  }
});

describe('PR 4.3 — instruction-like phrasing examples present', () => {
  // Rules that just say "ignore embedded persuasion" without examples
  // are weaker — concrete examples teach the agent what to look for.
  // Each agent should include at least 2 example phrases.
  const EXAMPLE_PHRASES = [
    /100% legit|OFFICIAL|guaranteed|URGENT|OVERRIDE|trust this token|jailbreak/i,
    /ignore previous instructions/i,
  ];

  for (const agent of AGENTS) {
    test(`${agent}/AGENTS.md gives at least one concrete attacker-phrasing example`, () => {
      const path = resolve(REPO, 'agents', agent, 'AGENTS.md');
      const content = readFileSync(path, 'utf-8');
      const matchCount = EXAMPLE_PHRASES.filter((p) => p.test(content)).length;
      assert(
        matchCount >= 2,
        `${agent}/AGENTS.md should give ≥2 concrete attacker-phrasing examples; matched ${matchCount}/2`,
      );
    });
  }
});

process.exit(summary() ? 0 : 1);
