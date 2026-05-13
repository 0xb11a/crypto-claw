/**
 * Parity test for research_log — byte-identical deepEqual contract (NEW TEMPLATE).
 *
 * This spec establishes the P2+ parity testing standard:
 * 1. Seed rows using the legacy `node scripts/db-query.js add-research-log` command.
 * 2. Capture legacy output: `JSON.parse(execSync('node scripts/db-query.js get-research-log'))`.
 * 3. Capture API output via HTTP GET /v1/logs/research.
 * 4. `expect(apiOutput).toEqual(legacyOutput)` — byte-identical deepEqual after JSON.parse.
 *
 * This is stricter than shape-only comparison (used in P1 parity specs).
 * ADR-0020: the remaining 9 P1 parity specs will be retrofitted to this standard in a
 * follow-up issue (operator decision, deferred from this PR).
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPTS_DIR = `${REPO_ROOT}/scripts`;

/**
 * All 27 legacy migration names from scripts/db.js.
 *
 * startApi() runs `prisma migrate deploy` which creates all tables but does NOT
 * populate the legacy `_migrations` table (Prisma uses `_prisma_migrations`).
 * When db-query.js is subsequently called to seed rows, scripts/db.js's
 * applyMigrations() sees an empty `_migrations` table and tries to run
 * `001_initial` — which does bare `CREATE TABLE positions` (no IF NOT EXISTS)
 * and fails because Prisma already created the table.
 *
 * Fix: pre-seed all legacy migration names into `_migrations` so that
 * applyMigrations() skips every DDL statement and goes straight to the INSERT.
 */
const LEGACY_MIGRATION_NAMES = [
  '001_initial', '002_paper_mode', '003_tracked_wallets_deployer_type',
  '004_wallet_scoring_pipeline', '005_market_regime', '006_analysis_cache',
  '007_wallet_source', '008_portfolio_sync', '009_per_chain_cash',
  '010_heartbeat_seeds_research', '011_position_exit_columns', '012_unified_orders',
  '013_contract_snapshots', '014_order_status', '015_multisig_tracking',
  '016_db_improvements', '017_narrative_deep_scan_heartbeat', '018_trailing_stops',
  '019_research_log', '020_ethereum_chain_cash', '021_observer_log',
  '022_approval_bot', '023_memory_backup_heartbeat', '024_smart_money_signals',
  '025_split_harvest_and_health_keys', '026_log_summary_columns', '027_cleanup_invalid_tiers',
];

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-rl-parity',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: 'ci-research-key-aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'ci-sentinel-key-aaaaaaaaaaaaaaaa',
  EXECUTOR_API_KEY: 'ci-executor-key-aaaaaaaaaaaaaaaa',
  OBSERVER_API_KEY: 'ci-observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa',
  WORKER_API_KEY: 'ci-worker-key-aaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'ci-scheduler-key-aaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'ci-dashboard-key-aaaaaaaaaaaaaaaa',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-openai-dummy',
  NODE_ENV: 'test',
  PRISMA_DISABLE_DOTENV: '1',
  SAFE_SIGNER_KEY: '',
  SQUADS_SIGNER_KEY: '',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

const PORT = 7885;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-rl-parity',
  });

  // Pre-seed the legacy _migrations table so that applyMigrations() in scripts/db.js
  // skips all DDL statements when db-query.js is called below.
  // Prisma creates tables via _prisma_migrations; the legacy _migrations table is empty,
  // causing applyMigrations() to attempt CREATE TABLE positions (no IF NOT EXISTS) → collision.
  const seedMigrationsScript = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH);
    db.exec('CREATE TABLE IF NOT EXISTS _migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT DEFAULT (datetime(\\'now\\')))');
    const insert = db.prepare('INSERT OR IGNORE INTO _migrations (name) VALUES (?)');
    ${LEGACY_MIGRATION_NAMES.map((n) => `insert.run(${JSON.stringify(n)});`).join('\n    ')}
    db.close();
  `;
  execFileSync('node', ['--eval', seedMigrationsScript], {
    env: { ...process.env, DB_PATH: api.dbPath },
    cwd: resolve(REPO_ROOT, 'scripts'),
    encoding: 'utf8',
    timeout: 10000,
  });

  // Seed 3 rows via legacy db-query.js using the same DB file the API serves
  const legacyEnv = {
    ...process.env,
    SAFE_ID: 'ci-rl-parity',
    DB_PATH: api.dbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${api.dbPath}`,
    PAPER_MODE: 'false',
    AUTO_APPROVE_BUY: 'false',
    AUTO_APPROVE_BUY_MAX_USD: '',
  };

  const seed = (payload: object) =>
    execFileSync('node', [
      `${SCRIPTS_DIR}/db-query.js`,
      'add-research-log',
      '--json',
      JSON.stringify(payload),
    ], { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });

  seed({ check_type: 'token_scan', tokens_scanned: 5, status: 'ok', summary: 'row 1' });
  seed({ check_type: 'smart_money', tokens_analyzed: 3, trades_proposed: 1, status: 'warn', summary: 'row 2' });
  seed({ check_type: 'narrative_check', watchlist_hits: 2, status: 'ok' });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('research_log parity — byte-identical deepEqual (NEW TEMPLATE)', () => {
  it.skipIf(SKIP)('API GET /v1/logs/research deepEquals legacy get-research-log output', async () => {
    // Capture legacy output against the same DB file
    const legacyRaw = execFileSync('node', [`${SCRIPTS_DIR}/db-query.js`, 'get-research-log'], {
      env: {
        ...process.env,
        SAFE_ID: 'ci-rl-parity',
        DB_PATH: api.dbPath,
        SAFE_SIGNER_KEY: '',
        SQUADS_SIGNER_KEY: '',
        PRISMA_DISABLE_DOTENV: '1',
        DATABASE_URL: `file:${api.dbPath}`,
        PAPER_MODE: 'false',
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    const legacyOutput = JSON.parse(legacyRaw) as unknown[];

    // Capture API output
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/logs/research?limit=50`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    // Byte-identical deepEqual — same rows, same field values, same field names
    expect(apiOutput).toEqual(legacyOutput);
  });
});
