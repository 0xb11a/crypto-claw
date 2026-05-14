/**
 * Parity test for contract_snapshots — byte-identical deepEqual contract.
 *
 * Template: research-log-parity.spec.ts (NEW TEMPLATE from P2g2).
 * Seeds via legacy db-query.js add-contract-snapshot.
 * Compares API GET /v1/contracts/snapshots with legacy get-contract-snapshots.
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
const TEST_ADDRESS = '0xparity_contract';
const TEST_CHAIN = 'base';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cs-parity',
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

const PORT = 7893;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-cs-parity',
  });

  // Pre-seed legacy _migrations
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
    SAFE_ID: 'ci-cs-parity',
    DB_PATH: api.dbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${api.dbPath}`,
    PAPER_MODE: 'false',
    AUTO_APPROVE_BUY: 'false',
    AUTO_APPROVE_BUY_MAX_USD: '',
  };

  const snap = (json: string) =>
    execFileSync('node', [
      `${SCRIPTS_DIR}/db-query.js`,
      'add-contract-snapshot',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--json', json,
    ], { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });

  snap(JSON.stringify({ is_honeypot: false, buy_tax: 0 }));
  snap(JSON.stringify({ is_honeypot: false, buy_tax: 0.05, owner_change_balance: true }));
  snap(JSON.stringify({ is_honeypot: true, buy_tax: 0 }));
}, 30_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('contract_snapshots parity — byte-identical deepEqual', () => {
  it.skipIf(SKIP)('API GET /v1/contracts/snapshots deepEquals legacy get-contract-snapshots output', async () => {
    const legacyEnv = {
      ...process.env,
      SAFE_ID: 'ci-cs-parity',
      DB_PATH: api.dbPath,
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
      PRISMA_DISABLE_DOTENV: '1',
      DATABASE_URL: `file:${api.dbPath}`,
      PAPER_MODE: 'false',
      AUTO_APPROVE_BUY: 'false',
      AUTO_APPROVE_BUY_MAX_USD: '',
    };

    const legacyRaw = execFileSync(
      'node',
      [`${SCRIPTS_DIR}/db-query.js`, 'get-contract-snapshots',
        '--address', TEST_ADDRESS, '--chain', TEST_CHAIN, '--limit', '5'],
      { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );
    const legacyOutput = JSON.parse(legacyRaw) as unknown[];

    const res = await fetch(
      `http://127.0.0.1:${PORT}/v1/contracts/snapshots?address=${TEST_ADDRESS}&chain=${TEST_CHAIN}&limit=5`,
      { headers: { Authorization: `Bearer ${AGENT_TOKEN}` } },
    );
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });
});
