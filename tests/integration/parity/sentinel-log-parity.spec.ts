/**
 * Parity test for sentinel_log — byte-identical deepEqual contract (NEW TEMPLATE).
 *
 * See research-log-parity.spec.ts for the template documentation.
 *
 * sentinel_log has a special note: `summary` was added via ALTER TABLE in migration 026,
 * so in the legacy SQLite DB the column order in SELECT * is:
 *   id, check_type, positions_checked, alerts_generated, sells_executed, status, created_at, summary
 *
 * The API uses Prisma which creates the table in a single CREATE TABLE (no ALTER TABLE),
 * so the physical column order differs. However, db-query.js returns rows as JS objects
 * with named keys — JSON.parse deepEqual compares by key name, not column order.
 * The parity test catches any field-name drift between legacy and API responses.
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
  SAFE_ID: 'ci-sl-parity',
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

const PORT = 7886;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-sl-parity',
  });

  const legacyEnv = {
    ...process.env,
    SAFE_ID: 'ci-sl-parity',
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
      'add-sentinel-log',
      '--json',
      JSON.stringify(payload),
    ], { env: legacyEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 });

  seed({ check_type: 'price_check', positions_checked: 3, alerts_generated: 1, status: 'ok' });
  seed({ check_type: 'liquidity_check', positions_checked: 2, sells_executed: 1, status: 'warn', summary: 'LP drop' });
  seed({ check_type: 'wallet_check', status: 'ok', summary: null });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

describe('sentinel_log parity — byte-identical deepEqual (NEW TEMPLATE)', () => {
  it.skipIf(SKIP)('API GET /v1/logs/sentinel deepEquals legacy get-sentinel-log output', async () => {
    const legacyRaw = execFileSync('node', [`${SCRIPTS_DIR}/db-query.js`, 'get-sentinel-log'], {
      env: {
        ...process.env,
        SAFE_ID: 'ci-sl-parity',
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

    const res = await fetch(`http://127.0.0.1:${PORT}/v1/logs/sentinel?limit=50`, {
      headers: { Authorization: `Bearer ${AGENT_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const apiOutput = (await res.json()) as unknown[];

    expect(apiOutput).toEqual(legacyOutput);
  });
});
