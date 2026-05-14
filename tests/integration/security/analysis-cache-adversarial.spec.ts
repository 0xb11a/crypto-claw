/**
 * Adversarial integration tests for analysis-cache module (DoD §F).
 *
 * 1. POST with reasoning > 10000 chars → still succeeds (no length limit on reasoning)
 * 2. POST with unknown field → 400 (forbidNonWhitelisted)
 * 3. POST with invalid analysis_score (string) → 400
 * 4. POST with ttl_hours > 720 → 400 (max)
 * 5. GET check with empty address → 400
 * 6. SQL injection attempt in chain param → 200 or sanitized (not 500)
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';
const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-analysis-cache-adversarial',
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

const PORT = 7889;
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-analysis-cache-adversarial',
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

describe('analysis-cache adversarial security (DoD §F)', () => {
  it.skipIf(SKIP)('POST with unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: 'buy', __proto__: {} },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST with invalid analysis_score (string) returns 400', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: 'buy', analysis_score: 'high' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST with ttl_hours > 720 returns 400', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: 'buy', ttl_hours: 10000 },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST with analysis_score > 100 returns 400', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: 'buy', analysis_score: 150 },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET check with empty address returns 400', async () => {
    const { status } = await req('GET', '/v1/analysis-cache/check?address=&chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET with limit > 500 returns 400', async () => {
    const { status } = await req('GET', '/v1/analysis-cache?limit=999', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('SQL injection in chain param does not cause 500', async () => {
    // Should return 200 (no results) or 400 — not 500 (server error)
    const { status } = await req(
      'GET',
      "/v1/analysis-cache/check?address=0x1&chain=base' OR '1'='1",
      { token: AGENT_TOKEN },
    );
    expect(status).not.toBe(500);
  });

  // Coder-flagged gap #1: empty string passes @IsString but fails @IsNotEmpty
  it.skipIf(SKIP)('POST with empty address string returns 400 (@IsNotEmpty)', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '', chain: 'base', verdict: 'buy' },
    });
    expect(status).toBe(400);
  });

  // Coder-flagged gap #1 (verdict variant): empty verdict string must also 400
  it.skipIf(SKIP)('POST with empty verdict string returns 400 (@IsNotEmpty)', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: '' },
    });
    expect(status).toBe(400);
  });
});
