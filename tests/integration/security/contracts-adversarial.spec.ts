/**
 * Adversarial integration tests for contracts module (DoD §F).
 *
 * 1. POST with json field > 65KB → 400
 * 2. POST with unknown field → 400 (forbidNonWhitelisted)
 * 3. POST missing required field → 400
 * 4. GET without address → 400
 * 5. GET with limit > 100 → 400
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';
const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-contracts-adversarial',
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

const PORT = 7890;
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-contracts-adversarial',
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

describe('contracts adversarial security (DoD §F)', () => {
  it.skipIf(SKIP)('POST with json > 65KB returns 400', async () => {
    const bigJson = 'x'.repeat(65537);
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', json: bigJson },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST with unknown field returns 400 (forbidNonWhitelisted)', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', json: '{}', injected_field: 'bad' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST missing json field returns 400', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base' },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET without address returns 400', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET with limit > 100 returns 400', async () => {
    const { status } = await req(
      'GET',
      '/v1/contracts/snapshots?address=0x1&chain=base&limit=999',
      { token: AGENT_TOKEN },
    );
    expect(status).toBe(400);
  });

  // Coder-flagged gap #2: empty string passes @IsString but fails @IsNotEmpty
  it.skipIf(SKIP)('POST with empty json string returns 400 (@IsNotEmpty)', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x1', chain: 'base', json: '' },
    });
    expect(status).toBe(400);
  });

  // Additional check §D: safety_data byte boundary
  it.skipIf(SKIP)('POST with json at exactly 65535 chars succeeds (just under @MaxLength cap)', async () => {
    // @MaxLength(65536) means 65536 is the max; 65535 is fine
    const borderJson = 'x'.repeat(65535);
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0xboundary', chain: 'base', json: borderJson },
    });
    expect(status).toBe(201);
  });

  it.skipIf(SKIP)('POST with json at 65537 chars (1 over cap) returns 400', async () => {
    // @MaxLength(65536) — 65537 must fail
    const overJson = 'x'.repeat(65537);
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0xboundary', chain: 'base', json: overJson },
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)("POST with json='{}' (smallest valid JSON string) succeeds", async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0xminimal', chain: 'base', json: '{}' },
    });
    expect(status).toBe(201);
  });
});
