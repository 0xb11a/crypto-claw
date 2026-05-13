/**
 * Parity test for executor_log — byte-identical deepEqual contract (NEW TEMPLATE).
 *
 * See research-log-parity.spec.ts for the template documentation.
 *
 * executor_log note: `summary` was added via ALTER TABLE in migration 026.
 * The legacy SELECT * column order is:
 *   id, sell_orders_processed, buy_orders_processed, pending_checked,
 *   success_count, fail_count, queued_count, status, created_at, summary
 *
 * The Prisma migration creates summary inline with the other columns.
 * JSON deepEqual is unaffected by physical column order (key-name comparison).
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');
const SCRIPTS_DIR = `${REPO_ROOT}/scripts`;

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-el-parity',
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

const PORT = 7887;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-el-parity',
  });

  const legacyEnv = {
    ...process.env,
    SAFE_ID: 'ci-el-parity',
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
      'add-executor-log',
      '--json',
      JSON.stringify(payload),
    ], { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });

  seed({ sell_orders_processed: 2, buy_orders_processed: 1, success_count: 3, status: 'ok' });
  seed({ sell_orders_processed: 0, buy_orders_processed: 0, pending_checked: 1, status: 'ok', summary: null });
  seed({ fail_count: 1, status: 'error', summary: 'nonce collision' });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('executor_log parity — byte-identical deepEqual (NEW TEMPLATE)', () => {
  it.skipIf(SKIP)('API GET /v1/logs/executor deepEquals legacy get-executor-log output', async () => {
    const legacyRaw = execFileSync('node', [`${SCRIPTS_DIR}/db-query.js`, 'get-executor-log'], {
      env: {
        ...process.env,
        SAFE_ID: 'ci-el-parity',
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

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/logs/executor?limit=50`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });
});
