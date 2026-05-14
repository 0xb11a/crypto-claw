/**
 * Integration tests for the contracts module (SPEC §7, DoD §A, §C).
 *
 * Routes:
 *   GET  /v1/contracts/snapshots?address&chain&limit — list (agent, dashboard)
 *   POST /v1/contracts/snapshots                     — add @Audited (agent)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'completely-unknown-token-xyz-12345';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-contracts-test',
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
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-contracts-integration',
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
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// Auth enforcement
// ---------------------------------------------------------------------------

describe('contracts — 401/403 auth enforcement', () => {
  it.skipIf(SKIP)('GET /v1/contracts/snapshots returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?address=0x1&chain=base');
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('GET /v1/contracts/snapshots returns 401 for unknown token', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?address=0x1&chain=base', {
      token: UNKNOWN_TOKEN,
    });
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('GET /v1/contracts/snapshots returns 200 for agent token', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?address=0x1&chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('GET /v1/contracts/snapshots returns 200 for dashboard token', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?address=0x1&chain=base', {
      token: DASHBOARD_TOKEN,
    });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('POST /v1/contracts/snapshots returns 403 for dashboard token', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: DASHBOARD_TOKEN,
      body: { address: '0x1', chain: 'base', json: '{}' },
    });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST happy-path and GET round-trip
// ---------------------------------------------------------------------------

describe('POST + GET /v1/contracts/snapshots', () => {
  let createdId: number;
  const safetyData = JSON.stringify({ is_honeypot: false, owner_change_balance: false, buy_tax: 0 });

  it.skipIf(SKIP)('POST creates snapshot and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0xcontract1', chain: 'base', json: safetyData },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(typeof row['id']).toBe('number');
    expect(row['address']).toBe('0xcontract1');
    expect(row['chain']).toBe('base');
    // safety_data is raw string — not parsed
    expect(row['safety_data']).toBe(safetyData);
    expect(typeof row['safety_data']).toBe('string');
    createdId = row['id'] as number;
  });

  it.skipIf(SKIP)('GET returns the snapshot', async () => {
    const { status, body } = await req(
      'GET',
      '/v1/contracts/snapshots?address=0xcontract1&chain=base',
      { token: AGENT_TOKEN },
    );
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    expect(Array.isArray(rows)).toBe(true);
    const found = rows.find((r) => r['id'] === createdId);
    expect(found).toBeDefined();
    expect(found!['safety_data']).toBe(safetyData);
  });

  it.skipIf(SKIP)('GET returns empty array for unknown contract', async () => {
    const { status, body } = await req(
      'GET',
      '/v1/contracts/snapshots?address=0xnotfound&chain=base',
      { token: AGENT_TOKEN },
    );
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it.skipIf(SKIP)('GET returns 400 when address or chain missing', async () => {
    const { status } = await req('GET', '/v1/contracts/snapshots?address=0x1', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Audit row (DoD §C)
// ---------------------------------------------------------------------------

describe('contracts — audit rows (DoD §C)', () => {
  it.skipIf(SKIP)('POST writes an audit row', async () => {
    await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0xaudit_contract', chain: 'solana', json: '{"audit":true}' },
    });
    const { status, body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) => typeof r['path'] === 'string' && r['path'].includes('/v1/contracts/snapshots'),
    );
    expect(found).toBeDefined();
  });
});
