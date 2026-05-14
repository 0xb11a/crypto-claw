/**
 * Integration tests for analysis-cache module (SPEC §7, DoD §A, §C).
 *
 * Routes covered:
 *   GET    /v1/analysis-cache           — list non-expired (agent, dashboard)
 *   POST   /v1/analysis-cache           — upsert @Audited (agent)
 *   GET    /v1/analysis-cache/check     — single-token check (agent, dashboard)
 *   DELETE /v1/analysis-cache/expired   — clear expired @Audited (agent)
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1 — spawns compiled API binary.
 * Requires `pnpm build` before running.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'completely-unknown-token-xyz-12345';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-analysis-cache-test',
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
const BASE = `http://127.0.0.1:${PORT}`;
let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-analysis-cache-integration',
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

describe('analysis-cache — 401/403 auth enforcement', () => {
  it.skipIf(SKIP)('GET /v1/analysis-cache returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache');
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('GET /v1/analysis-cache returns 401 for unknown token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache', { token: UNKNOWN_TOKEN });
    expect(status).toBe(401);
  });

  it.skipIf(SKIP)('GET /v1/analysis-cache returns 200 for agent token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache', { token: AGENT_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('GET /v1/analysis-cache returns 200 for dashboard token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('POST /v1/analysis-cache returns 403 for dashboard token', async () => {
    const { status } = await req('POST', '/v1/analysis-cache', {
      token: DASHBOARD_TOKEN,
      body: { address: '0x1', chain: 'base', verdict: 'buy' },
    });
    expect(status).toBe(403);
  });

  it.skipIf(SKIP)('DELETE /v1/analysis-cache/expired returns 403 for dashboard token', async () => {
    const { status } = await req('DELETE', '/v1/analysis-cache/expired', { token: DASHBOARD_TOKEN });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// POST upsert and GET round-trip
// ---------------------------------------------------------------------------

describe('POST + GET /v1/analysis-cache', () => {
  it.skipIf(SKIP)('POST creates cache entry and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: {
        address: '0xabc123',
        chain: 'base',
        symbol: 'TKN',
        analysis_score: 80,
        risk_score: 25,
        verdict: 'buy',
        tier: 'moonshot',
        reasoning: 'strong fundamentals',
        ttl_hours: 24,
      },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['address']).toBe('0xabc123');
    expect(row['chain']).toBe('base');
    expect(row['verdict']).toBe('buy');
    expect(row['analysis_score']).toBe(80);
    // expires_at should be non-Z SQLite format (YYYY-MM-DD HH:MM:SS)
    expect(typeof row['expires_at']).toBe('string');
    expect((row['expires_at'] as string)).not.toContain('Z');
    expect((row['expires_at'] as string)).not.toContain('T');
  });

  it.skipIf(SKIP)('GET /v1/analysis-cache returns the non-expired entry', async () => {
    const { status, body } = await req('GET', '/v1/analysis-cache', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    const found = rows.find((r) => r['address'] === '0xabc123');
    expect(found).toBeDefined();
    expect(found!['verdict']).toBe('buy');
  });

  it.skipIf(SKIP)('POST upsert updates existing entry (same address/chain)', async () => {
    const { status, body } = await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: {
        address: '0xabc123',
        chain: 'base',
        verdict: 'hold',
        ttl_hours: 12,
      },
    });
    expect(status).toBe(201);
    expect((body as Record<string, unknown>)['verdict']).toBe('hold');
  });
});

// ---------------------------------------------------------------------------
// GET /check
// ---------------------------------------------------------------------------

describe('GET /v1/analysis-cache/check', () => {
  it.skipIf(SKIP)('returns 200 when token is cached (non-expired)', async () => {
    const { status, body } = await req('GET', '/v1/analysis-cache/check?address=0xabc123&chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['address']).toBe('0xabc123');
  });

  it.skipIf(SKIP)('returns 404 when token not in cache', async () => {
    const { status } = await req('GET', '/v1/analysis-cache/check?address=0xnotcached&chain=base', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(404);
  });

  it.skipIf(SKIP)('returns 400 when address or chain missing', async () => {
    const { status } = await req('GET', '/v1/analysis-cache/check?address=0xabc123', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// DELETE /expired
// ---------------------------------------------------------------------------

describe('DELETE /v1/analysis-cache/expired', () => {
  it.skipIf(SKIP)('returns 200 with ok=true and deleted count', async () => {
    const { status, body } = await req('DELETE', '/v1/analysis-cache/expired', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
    const result = body as Record<string, unknown>;
    expect(result['ok']).toBe(true);
    expect(typeof result['deleted']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Audit row written (DoD §C)
// ---------------------------------------------------------------------------

describe('analysis-cache — audit rows (DoD §C)', () => {
  it.skipIf(SKIP)('POST /v1/analysis-cache writes an audit row', async () => {
    await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: '0xaudit_test', chain: 'solana', verdict: 'avoid' },
    });
    const { status: auditStatus, body: auditBody } = await req('GET', '/v1/system/audit', {
      token: AGENT_TOKEN,
    });
    expect(auditStatus).toBe(200);
    const rows = (auditBody as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) => typeof r['path'] === 'string' && r['path'].includes('/v1/analysis-cache'),
    );
    expect(found).toBeDefined();
  });
});
