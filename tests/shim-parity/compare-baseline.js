#!/usr/bin/env node
/**
 * compare-baseline.js — Re-runs every (command, args) pair recorded in the
 * baseline manifest and asserts byte-identical stdout. Used in CI as the
 * shim-parity gate during P1–P4.
 *
 * Usage:
 *   node tests/shim-parity/compare-baseline.js --safe-id <id> [--cclaw]
 *
 * Without --cclaw: re-runs against the legacy `node scripts/db-query.js …`.
 *   This is the sanity check during P-prep — confirms the baseline is
 *   reproducible against the same DB.
 *
 * With --cclaw: re-runs against `cclaw …`. This is the P1–P3 gate — confirms
 *   the new CLI emits identical JSON.
 *
 * Exit codes:
 *   0 — every snapshot matches
 *   1 — at least one snapshot drifted; per-snapshot diffs printed to stderr
 *   2 — invalid invocation or missing manifest
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const BASELINE = resolve(import.meta.dirname, 'baseline');
const MANIFEST = resolve(BASELINE, 'manifest.json');

const argv = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => {
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : 'true';
      acc.push([key, val]);
    }
    return acc;
  }, []),
);

const SAFE_ID = argv['safe-id'];
const USE_CCLAW = argv.cclaw === 'true';

if (!SAFE_ID) {
  console.error('error: --safe-id <id> is required');
  process.exit(2);
}
if (!existsSync(MANIFEST)) {
  console.error(`error: ${MANIFEST} not found — capture the baseline first`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

function runLegacy(name, args) {
  const dbq = resolve(REPO_ROOT, 'scripts', 'db-query.js');
  return execFileSync('node', [dbq, name, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SAFE_ID },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function runCclaw(name, args) {
  // Map db-query subcommand -> `cclaw <resource> <verb>` per the OpenAPI spec.
  // The mapping table is generated alongside the api build; this stub
  // assumes `cclaw <name> <args>` for now and will be replaced by the
  // generator output in P1.
  return execFileSync('cclaw', [name, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SAFE_ID },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

let drift = 0;
let matched = 0;

for (const entry of manifest.entries) {
  const expected = readFileSync(resolve(REPO_ROOT, entry.path), 'utf8');
  let actual;
  try {
    actual = USE_CCLAW ? runCclaw(entry.command, entry.args) : runLegacy(entry.command, entry.args);
  } catch (err) {
    console.error(`[fail] ${entry.command} ${entry.args.join(' ')} — invocation error: ${err.message}`);
    drift++;
    continue;
  }

  if (actual === expected) {
    matched++;
  } else {
    drift++;
    console.error(`\n[drift] ${entry.command} ${entry.args.join(' ')}`);
    console.error(`         expected (${entry.path})`);
    console.error(`         actual differs (${actual.length} vs ${expected.length} bytes)`);
  }
}

console.error(`\n[baseline] matched ${matched} / drift ${drift} of ${manifest.entries.length}`);
process.exit(drift === 0 ? 0 : 1);
