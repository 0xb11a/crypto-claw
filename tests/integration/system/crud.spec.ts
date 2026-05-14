/**
 * Integration tests for the system module (SPEC §7, DoD §A, §C).
 *
 * Routes:
 *   GET   /v1/system/meta?key=         — get meta key (agent, dashboard)
 *   PATCH /v1/system/meta              — set meta key @Audited (agent)
 *   GET   /v1/system/cash              — all-chain cash breakdown (agent, dashboard)
 *   GET   /v1/system/cash/:chain       — single-chain cash (agent, dashboard)
 *   PATCH /v1/system/cash              — set cash @Audited (agent)
 *   GET   /v1/system/gas?chain=        — gas info (agent, dashboard)
 *   GET   /v1/system/sync-status       — portfolio sync history (agent, dashboard)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-system-test',
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

const PORT = 7888;
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-system-integration',
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
// Meta
// ---------------------------------------------------------------------------

describe('system/meta — GET and PATCH', () => {
  it.skipIf(SKIP)('GET returns existing key (safe_id seeded by migration)', async () => {
    const { status, body } = await req('GET', '/v1/system/meta?key=safe_id', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
    const row = body as Record<string, unknown>;
    expect(row['key']).toBe('safe_id');
    expect(row['value']).toBe('ci-system-test');
  });

  it.skipIf(SKIP)('GET returns null value for missing key', async () => {
    const { status, body } = await req('GET', '/v1/system/meta?key=nonexistent_key_xyz', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['value']).toBeNull();
  });

  it.skipIf(SKIP)('PATCH sets a meta key/value', async () => {
    const { status, body } = await req('PATCH', '/v1/system/meta', {
      token: AGENT_TOKEN,
      body: { key: 'test_meta_key', value: 'test_value_123' },
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['ok']).toBe(true);
  });

  it.skipIf(SKIP)('PATCH then GET round-trip', async () => {
    await req('PATCH', '/v1/system/meta', {
      token: AGENT_TOKEN,
      body: { key: 'roundtrip_key', value: 'roundtrip_value' },
    });
    const { body } = await req('GET', '/v1/system/meta?key=roundtrip_key', {
      token: AGENT_TOKEN,
    });
    expect((body as Record<string, unknown>)['value']).toBe('roundtrip_value');
  });

  it.skipIf(SKIP)('GET returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/system/meta?key=safe_id');
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('PATCH returns 403 for dashboard token', async () => {
    const { status } = await req('PATCH', '/v1/system/meta', {
      token: DASHBOARD_TOKEN,
      body: { key: 'x', value: 'y' },
    });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Cash
// ---------------------------------------------------------------------------

describe('system/cash — GET and PATCH', () => {
  it.skipIf(SKIP)('GET /v1/system/cash returns flat breakdown object', async () => {
    const { status, body } = await req('GET', '/v1/system/cash', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const breakdown = body as Record<string, number>;
    expect(typeof breakdown['total']).toBe('number');
  });

  it.skipIf(SKIP)('GET /v1/system/cash/:chain returns chain/cash shape', async () => {
    const { status, body } = await req('GET', '/v1/system/cash/base', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result['chain']).toBe('base');
    expect(typeof result['cash']).toBe('number');
  });

  it.skipIf(SKIP)('PATCH /v1/system/cash sets cash for a chain', async () => {
    const { status, body } = await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'base', amount: 999.5 },
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['ok']).toBe(true);
    expect((body as Record<string, unknown>)['cash']).toBe(999.5);
  });

  it.skipIf(SKIP)('PATCH then GET /v1/system/cash/:chain round-trip', async () => {
    await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'solana', amount: 123.45 },
    });
    const { body } = await req('GET', '/v1/system/cash/solana', { token: AGENT_TOKEN });
    expect((body as Record<string, unknown>)['cash']).toBe(123.45);
  });
});

// ---------------------------------------------------------------------------
// Gas
// ---------------------------------------------------------------------------

describe('system/gas — GET', () => {
  it.skipIf(SKIP)('returns zero defaults when not set', async () => {
    const { status, body } = await req('GET', '/v1/system/gas?chain=base', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result['chain']).toBe('base');
    expect(result['balance']).toBe(0);
    expect(result['price']).toBe(0);
    expect(result['value_usd']).toBe(0);
  });

  it.skipIf(SKIP)('returns 400 when chain missing', async () => {
    const { status } = await req('GET', '/v1/system/gas', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Sync status
// ---------------------------------------------------------------------------

describe('system/sync-status — GET', () => {
  it.skipIf(SKIP)('returns empty array when no sync records', async () => {
    const { status, body } = await req('GET', '/v1/system/sync-status', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it.skipIf(SKIP)('returns 200 with chain filter', async () => {
    const { status } = await req('GET', '/v1/system/sync-status?chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('returns 200 for dashboard token (read-only)', async () => {
    const { status } = await req('GET', '/v1/system/sync-status', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Audit rows (DoD §C)
// ---------------------------------------------------------------------------

describe('system — audit rows (DoD §C)', () => {
  it.skipIf(SKIP)('PATCH /v1/system/meta writes an audit row', async () => {
    await req('PATCH', '/v1/system/meta', {
      token: AGENT_TOKEN,
      body: { key: 'audit_test_key', value: 'audit_test_value' },
    });
    const { status, body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) => typeof r['path'] === 'string' && r['path'].includes('/v1/system/meta'),
    );
    expect(found).toBeDefined();
  });
});
