/**
 * Parity test for smart_money_signals — byte-identical deepEqual contract (P2 retrofit).
 *
 * Template: research-log-parity.spec.ts
 * 1. Seed signals directly via better-sqlite3 inline script (no insert CLI command exists)
 * 2. Capture legacy: JSON.parse(execFileSync('node', ['scripts/db-query.js', 'get-smart-money-signals', '--since', '60m']))
 * 3. Capture API:    await fetch('http://127.0.0.1:7892/v1/wallets/signals?since=60m')
 * 4. expect(apiOutput).toEqual(legacyOutput) — byte-identical deepEqual
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
  SAFE_ID: 'ci-sig-parity',
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
    tmpPrefix: 'cclaw-sig-parity',
  });

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
    SAFE_ID: 'ci-sig-parity',
    DB_PATH: api.dbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${api.dbPath}`,
    PAPER_MODE: 'false',
    AUTO_APPROVE_BUY: 'false',
    AUTO_APPROVE_BUY_MAX_USD: '',
  };

  // Init DB by running any db-query command (triggers auto-migration)
  execFileSync('node', [`${SCRIPTS_DIR}/db-query.js`, 'get-tracked-wallets'], {
    env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000,
  });

  // Insert signals directly via better-sqlite3 (no CLI insert command exists for signals)
  const insertScript = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH);
    const now = new Date().toISOString();
    const stmt = db.prepare(\`
      INSERT OR IGNORE INTO smart_money_signals
        (tx_hash, chain, wallet_address, wallet_score, action, token_address, token_symbol, tx_timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`);
    stmt.run('0xptx1', 'base', '0xParityWallet001', 85, 'buy', '0xParityToken001', 'PTK', now, now);
    stmt.run('0xptx2', 'base', '0xParityWallet002', 90, 'buy', '0xParityToken001', 'PTK', now, now);
    stmt.run('0xptx3', 'base', '0xParityWallet001', 85, 'sell', '0xParityToken002', 'PT2', now, now);
    db.close();
  `;
  execFileSync('node', ['--eval', insertScript], {
    env: { ...legacyEnv },
    cwd: resolve(REPO_ROOT, 'scripts'),
    encoding: 'utf8',
    timeout: 10000,
  });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('signals parity — byte-identical deepEqual (P2 retrofit)', () => {
  it.skipIf(SKIP)('API GET /v1/wallets/signals?since=60m deepEquals legacy get-smart-money-signals --since 60m', async () => {
    const legacyRaw = execFileSync(
      'node', [`${SCRIPTS_DIR}/db-query.js`, 'get-smart-money-signals', '--since', '60m'],
      {
        env: {
          ...process.env,
          SAFE_ID: 'ci-sig-parity',
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
      },
    );
    const legacyOutput = JSON.parse(legacyRaw) as unknown[];

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/wallets/signals?since=60m`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });

  it.skipIf(SKIP)('API GET /v1/wallets/signals?since=60m&action=buy deepEquals legacy --since 60m --action buy', async () => {
    const legacyRaw = execFileSync(
      'node', [`${SCRIPTS_DIR}/db-query.js`, 'get-smart-money-signals', '--since', '60m', '--action', 'buy'],
      {
        env: {
          ...process.env,
          SAFE_ID: 'ci-sig-parity',
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
      },
    );
    const legacyOutput = JSON.parse(legacyRaw) as unknown[];

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/wallets/signals?since=60m&action=buy`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });
});
