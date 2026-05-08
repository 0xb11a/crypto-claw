#!/usr/bin/env node
/**
 * capture-baseline.js — Captures stdout snapshots for every read-only db-query
 * subcommand against a populated dev DB. Operator-run, idempotent.
 *
 * Usage:
 *   node tests/shim-parity/capture-baseline.js --safe-id <id> [--commit-baseline]
 *
 * Output:
 *   tests/shim-parity/baseline/manifest.json
 *   tests/shim-parity/baseline/<command>/<argHash>.json
 *
 * See tests/shim-parity/README.md for the full lifecycle.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
const DB_QUERY = resolve(REPO_ROOT, 'scripts', 'db-query.js');
const BASELINE = resolve(import.meta.dirname, 'baseline');

// ---------------------------------------------------------------------------
// Args
// ---------------------------------------------------------------------------
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
if (!SAFE_ID) {
  console.error('error: --safe-id <id> is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Read-only command surface
// ---------------------------------------------------------------------------
//
// Each entry: command name, plus an optional `argsFn(samples) => string[]`.
// Commands without args produce a single snapshot. Commands with args run
// once per sampled value and produce one snapshot per `argHash`.
//
// `samples` is built by querying the populated DB once at the top of the run.
// ---------------------------------------------------------------------------

const READ_COMMANDS = [
  // No-arg
  { name: 'get-positions' },
  { name: 'get-positions', argsFn: () => ['--status', 'open'] },
  { name: 'get-positions', argsFn: () => ['--status', 'closed'] },
  { name: 'get-portfolio' },
  { name: 'get-cash' },
  { name: 'get-gas' },
  { name: 'get-chains' },
  { name: 'get-orders' },
  { name: 'get-orders', argsFn: () => ['--pending'] },
  { name: 'get-order-history' },
  { name: 'get-order-history', argsFn: () => ['--limit', '20'] },
  { name: 'get-receipts' },
  { name: 'get-alerts' },
  { name: 'get-alerts', argsFn: () => ['--unprocessed'] },
  { name: 'get-watchlist' },
  { name: 'get-watchlist', argsFn: () => ['--active'] },
  { name: 'get-tracked-wallets' },
  { name: 'get-tracked-wallets', argsFn: () => ['--status', 'scored'] },
  { name: 'get-tracked-wallets', argsFn: () => ['--status', 'proposed'] },
  { name: 'get-unscored-wallets', argsFn: () => ['--limit', '5'] },
  { name: 'get-smart-money-signals', argsFn: () => ['--since', '24h'] },
  { name: 'get-smart-money-signals', argsFn: () => ['--since', '24h', '--action', 'buy'] },
  { name: 'get-smart-money-signals', argsFn: () => ['--since', '24h', '--action', 'sell'] },
  { name: 'get-heartbeats' },
  { name: 'get-trades' },
  { name: 'get-trade-stats' },
  { name: 'get-paper-positions' },
  { name: 'get-paper-portfolio' },
  { name: 'get-paper-cash' },
  { name: 'get-paper-stats' },
  { name: 'get-paper-receipts' },
  { name: 'get-sentinel-log' },
  { name: 'get-executor-log' },
  { name: 'get-research-log' },
  { name: 'get-observer-log' },
  { name: 'get-analysis-cache' },
  { name: 'get-sync-status' },

  // Per-chain
  { name: 'get-chain-config', argsFn: (s) => ['--chain', s.chain] },

  // Per-id (sampled)
  { name: 'get-position', argsFn: (s) => ['--id', String(s.positionId)] },
  { name: 'get-order', argsFn: (s) => ['--id', String(s.orderId)] },
  { name: 'get-receipt', argsFn: (s) => ['--id', String(s.receiptId)] },

  // Per-agent
  { name: 'get-heartbeat', argsFn: () => ['--agent', 'research'] },
  { name: 'get-heartbeat', argsFn: () => ['--agent', 'sentinel'] },
  { name: 'get-heartbeat', argsFn: () => ['--agent', 'executor'] },
  { name: 'get-heartbeat', argsFn: () => ['--agent', 'observer'] },
  { name: 'get-overdue-checks', argsFn: () => ['--agent', 'sentinel'] },
  { name: 'get-overdue-checks', argsFn: () => ['--agent', 'executor'] },

  // Per-token (sampled — needs both address + chain)
  {
    name: 'get-liquidity',
    argsFn: (s) => ['--address', s.tokenAddress, '--chain', s.tokenChain],
  },
  {
    name: 'get-contract-snapshots',
    argsFn: (s) => ['--address', s.tokenAddress, '--chain', s.tokenChain],
  },
  {
    name: 'check-token-status',
    argsFn: (s) => ['--address', s.tokenAddress, '--chain', s.tokenChain],
  },

  // Per-meta-key (a few well-known keys)
  { name: 'get-meta', argsFn: () => ['--key', 'last_birdeye_harvest_at'] },
  { name: 'get-meta', argsFn: () => ['--key', 'last_score_wallets_bg_at'] },
  { name: 'get-meta', argsFn: () => ['--key', 'last_activity_wallets_bg_at'] },
];

// ---------------------------------------------------------------------------
// Sample real IDs / addresses from the populated DB
// ---------------------------------------------------------------------------

function runQuery(args) {
  return execFileSync('node', [DB_QUERY, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, SAFE_ID },
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
}

function sample() {
  const positions = JSON.parse(runQuery(['get-positions', '--status', 'open']));
  const positionId = positions[0]?.id ?? null;

  const orders = JSON.parse(runQuery(['get-order-history', '--limit', '1']));
  const orderId = orders[0]?.id ?? null;

  const receipts = JSON.parse(runQuery(['get-receipts']));
  const receiptId = receipts[0]?.id ?? null;

  const tokenAddress = positions[0]?.token_address ?? null;
  const tokenChain = positions[0]?.chain ?? null;
  const chain = positions[0]?.chain ?? 'base';

  return { positionId, orderId, receiptId, tokenAddress, tokenChain, chain };
}

// ---------------------------------------------------------------------------
// Capture
// ---------------------------------------------------------------------------

function argHash(args) {
  return createHash('sha256').update(args.join(' ')).digest('hex').slice(0, 12);
}

function snapshotPath(name, args) {
  const file = args.length === 0 ? 'noargs.json' : `${argHash(args)}.json`;
  return resolve(BASELINE, name, file);
}

function ensureDir(p) {
  mkdirSync(dirname(p), { recursive: true });
}

function main() {
  if (!existsSync(DB_QUERY)) {
    console.error(`error: ${DB_QUERY} not found — did the legacy scripts/ get deleted?`);
    process.exit(1);
  }

  const samples = sample();
  console.error(`[baseline] sampled ids:`, samples);

  const manifest = { safeId: SAFE_ID, capturedAt: new Date().toISOString(), entries: [] };
  let captured = 0;
  let skipped = 0;

  for (const cmd of READ_COMMANDS) {
    const args = cmd.argsFn ? cmd.argsFn(samples) : [];
    if (args.some((a) => a === null || a === undefined || a === 'null')) {
      console.error(`[skip] ${cmd.name} — sample missing for required arg`);
      skipped++;
      continue;
    }
    const out = runQuery([cmd.name, ...args]);
    const path = snapshotPath(cmd.name, args);
    ensureDir(path);
    writeFileSync(path, out);
    manifest.entries.push({ command: cmd.name, args, path: path.replace(REPO_ROOT + '/', '') });
    captured++;
    console.error(`[ok] ${cmd.name} ${args.join(' ')}`);
  }

  const manifestPath = resolve(BASELINE, 'manifest.json');
  ensureDir(manifestPath);
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

  console.error(`\n[baseline] captured ${captured} / skipped ${skipped}`);
  console.error(`[baseline] manifest at ${manifestPath}`);
}

main();
