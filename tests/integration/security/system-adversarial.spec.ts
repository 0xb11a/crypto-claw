/**
 * Adversarial integration tests for system module (DoD §F).
 *
 * 1. GET meta with empty key → 400
 * 2. PATCH meta with missing value → 400
 * 3. PATCH meta with unknown field → 400
 * 4. PATCH cash with non-numeric amount → 400
 * 5. GET sync-status with limit > 100 → 400
 * 6. GET gas without chain → 400
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';
const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-system-adversarial',
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

const PORT = 7891;
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-system-adversarial',
  });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

async function req(
  method: string,
  path: string,
  opts: { body?: unknown; token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

describe('system adversarial security (DoD §F)', () => {
  it.skipIf(SKIP)('GET /v1/system/meta with empty key returns 400', async () => {
    const { status } = await req('GET', '/v1/system/meta?key=', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('PATCH /v1/system/meta missing value returns 400', async () => {
    const { status } = await req('PATCH', '/v1/system/meta', {
      token: AGENT_TOKEN,
      body: { key: 'x' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('PATCH /v1/system/meta with unknown field returns 400', async () => {
    const { status } = await req('PATCH', '/v1/system/meta', {
      token: AGENT_TOKEN,
      body: { key: 'x', value: 'y', injected: 'bad' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('PATCH /v1/system/cash with non-numeric amount returns 400', async () => {
    const { status } = await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'base', amount: 'not_a_number' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/system/sync-status with limit > 100 returns 400', async () => {
    const { status } = await req('GET', '/v1/system/sync-status?limit=999', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/system/gas without chain returns 400', async () => {
    const { status } = await req('GET', '/v1/system/gas', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });
});
