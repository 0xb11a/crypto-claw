#!/usr/bin/env node
/**
 * compare-baseline.js — Re-runs every (command, args) pair recorded in the
 * baseline manifest and asserts byte-identical stdout. Used in CI as the
 * shim-parity gate during P1–P4.
 *
 * Usage:
 *   node tests/shim-parity/compare-baseline.js --safe-id <id> [--cclaw] [--only positions,orders]
 *
 * Without --cclaw: re-runs against the legacy `node scripts/db-query.js …`.
 *   This is the sanity check during P-prep — confirms the baseline is
 *   reproducible against the same DB.
 *
 * With --cclaw: re-runs against `cclaw …`. This is the P1–P3 gate — confirms
 *   the new CLI emits identical JSON.
 *
 * --only positions,orders
 *   Filter the manifest to only compare entries whose command matches one of
 *   the provided module names. Commands not in the list are skipped (printed
 *   as "skipped" rather than "fail"). The list maps to commands like:
 *     positions → get-positions, get-position
 *     orders → get-orders, get-order-history, get-order
 *
 * IMPLEMENTED_COMMANDS: the allowlist of commands that have a P1a implementation.
 * Update this list as each module ships in subsequent PRs.
 *
 * Exit codes:
 *   0 — every in-scope snapshot matches (or was skipped)
 *   1 — at least one in-scope snapshot drifted; per-snapshot diffs printed to stderr
 *   2 — invalid invocation or missing manifest
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const BASELINE = resolve(import.meta.dirname, 'baseline');
const MANIFEST = resolve(BASELINE, 'manifest.json');

/**
 * Commands that have a P1a implementation in the new Prisma/cclaw path.
 * Keys are module names (--only values); values are db-query.js command prefixes.
 *
 * Update this list as each module ships:
 * - P1a: positions, orders
 * - P1b: receipts, alerts, heartbeat (deferred)
 * - P2+: remaining modules (deferred)
 */
const IMPLEMENTED_COMMANDS = {
  positions: ['get-positions', 'get-position'],
  orders: ['get-orders', 'get-order-history', 'get-order'],
};

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
const ONLY_MODULES = argv.only ? argv.only.split(',').map((s) => s.trim()) : null;

if (!SAFE_ID) {
  console.error('error: --safe-id <id> is required');
  process.exit(2);
}
if (!existsSync(MANIFEST)) {
  console.error(`error: ${MANIFEST} not found — capture the baseline first`);
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));

// Build set of command prefixes that are in scope
const inScopeCommands = ONLY_MODULES
  ? new Set(
      ONLY_MODULES.flatMap((module) => {
        const cmds = IMPLEMENTED_COMMANDS[module];
        if (!cmds) {
          console.error(`[warn] --only module '${module}' not recognised; skipping`);
          return [];
        }
        return cmds;
      }),
    )
  : null; // null = all commands in scope

function isInScope(command) {
  if (!inScopeCommands) return true;
  return inScopeCommands.has(command);
}

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
let skipped = 0;

for (const entry of manifest.entries) {
  if (!isInScope(entry.command)) {
    skipped++;
    continue;
  }

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

const scopeMsg = ONLY_MODULES ? ` (--only ${ONLY_MODULES.join(',')})` : '';
console.error(
  `\n[baseline] matched ${matched} / drift ${drift} / skipped ${skipped} of ${manifest.entries.length}${scopeMsg}`,
);
process.exit(drift === 0 ? 0 : 1);
