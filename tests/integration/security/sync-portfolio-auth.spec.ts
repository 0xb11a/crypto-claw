/**
 * Security integration tests for POST /v1/system/sync-portfolio.
 *
 * SPEC §14 — security tests under tests/integration/security/.
 * DoD §F  — auth/guards: every new write handler tested for 401/403.
 *
 * Covers:
 *   - 401 without any token
 *   - 401 with a syntactically invalid token
 *   - 403 for dashboard role (read-only role cannot enqueue jobs)
 *   - 200/202 for agent role (confirmed allowed)
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7908
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';
const INVALID_TOKEN = 'not-a-real-token-xxxxxxxxxxxxxxxx';

const PORT = 7908;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-sync-portfolio-auth-test',
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
  PAPER_MODE: 'false',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-sync-portfolio-auth',
  });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

const VALID_BODY = { chain: 'base' };

describe('POST /v1/system/sync-portfolio — security (DoD §F)', () => {
  it.skipIf(SKIP)('returns 401 without any token', async () => {
    const { status } = await req('POST', '/v1/system/sync-portfolio', {
      body: VALID_BODY,
    });
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('returns 401 with an invalid (unrecognized) token', async () => {
    const { status } = await req('POST', '/v1/system/sync-portfolio', {
      token: INVALID_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('returns 403 for dashboard role on POST (write route requires agent role)', async () => {
    const { status } = await req('POST', '/v1/system/sync-portfolio', {
      token: DASHBOARD_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(403);
  });

  it.skipIf(SKIP)('returns 202 for agent role (research token)', async () => {
    const { status } = await req('POST', '/v1/system/sync-portfolio', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(202);
  });

  it.skipIf(SKIP)('sentinel token (agent role) is also authorized — 202', async () => {
    const { status } = await req('POST', '/v1/system/sync-portfolio', {
      token: 'ci-sentinel-key-aaaaaaaaaaaaaaaa',
      body: VALID_BODY,
    });
    expect(status).toBe(202);
  });

  it.skipIf(SKIP)('returns 401 for Bearer with empty token value', async () => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ',
    };
    const res = await fetch(`${BASE}/v1/system/sync-portfolio`, {
      method: 'POST',
      headers,
      body: JSON.stringify(VALID_BODY),
    });
    expect(res.status).toBe(401);
  });
});
