/**
 * Parity test for analysis_cache — byte-identical deepEqual contract.
 *
 * Template: research-log-parity.spec.ts (NEW TEMPLATE from P2g2).
 * 1. Seed rows via legacy `node scripts/db-query.js cache-analysis`.
 * 2. Capture legacy output: `db-query.js get-analysis-cache`.
 * 3. Capture API output: GET /v1/analysis-cache.
 * 4. `expect(apiOutput).toEqual(legacyOutput)` — byte-identical deepEqual.
 *
 * expires_at parity: both legacy and API use datetime('now', '+N hours') via
 * SQLite raw SQL. The test seeds with ttl_hours=48 and immediately reads back;
 * the exact value will differ slightly between legacy and API calls in a running
 * test but the FORMAT is what matters — both use "YYYY-MM-DD HH:MM:SS" (non-Z).
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPTS_DIR = `${REPO_ROOT}/scripts`;

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
  SAFE_ID: 'ci-ac-parity',
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

const PORT = 7892;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-ac-parity',
  });

  // Pre-seed legacy _migrations table
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

  const legacyEnv = {
    ...process.env,
    SAFE_ID: 'ci-ac-parity',
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
      'cache-analysis',
      '--json',
      JSON.stringify(payload),
    ], { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });

  seed({ address: '0xtoken1', chain: 'base', symbol: 'TKN1', analysis_score: 75, risk_score: 30, verdict: 'buy', tier: 'moonshot', reasoning: 'good', ttl_hours: 48 });
  seed({ address: '0xtoken2', chain: 'base', symbol: 'TKN2', verdict: 'avoid', ttl_hours: 24 });
  seed({ address: '0xtoken3', chain: 'solana', analysis_score: 50, verdict: 'hold', tier: 'conviction', ttl_hours: 72 });
}, 30_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('analysis_cache parity — byte-identical deepEqual', () => {
  it.skipIf(SKIP)('API GET /v1/analysis-cache deepEquals legacy get-analysis-cache output', async () => {
    const legacyEnv = {
      ...process.env,
      SAFE_ID: 'ci-ac-parity',
      DB_PATH: api.dbPath,
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
      PRISMA_DISABLE_DOTENV: '1',
      DATABASE_URL: `file:${api.dbPath}`,
      PAPER_MODE: 'false',
      AUTO_APPROVE_BUY: 'false',
      AUTO_APPROVE_BUY_MAX_USD: '',
    };

    const legacyRaw = execFileSync('node', [`${SCRIPTS_DIR}/db-query.js`, 'get-analysis-cache'], {
      env: legacyEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    const legacyOutput = JSON.parse(legacyRaw) as unknown[];

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/analysis-cache?limit=50`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });
});
