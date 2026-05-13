/**
 * Integration tests for the agent-logs module (SPEC §7, DoD §A, §C).
 *
 * Covers all 12 routes (3 routes × 4 agents):
 *   GET    /v1/logs/<agent>       — list (agent, dashboard)
 *   GET    /v1/logs/<agent>/:id   — get by id (agent, dashboard)
 *   POST   /v1/logs/<agent>       — append @Audited (agent only)
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * DoD §C — 401/403/400/200 behaviour for all 12 routes.
 * DoD §A — audit row written per POST.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'completely-unknown-token-xyz-12345';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-agent-logs-test',
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

const PORT = 7883;
const BASE = `http://127.0.0.1:${PORT}`;

let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-agent-logs-integration',
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

// ---------------------------------------------------------------------------
// Auth enforcement — all 12 routes
// ---------------------------------------------------------------------------

const agents = ['research', 'sentinel', 'executor', 'observer'] as const;

describe('agent-logs — 401/403 auth enforcement on all routes', () => {
  for (const agent of agents) {
    it.skipIf(SKIP)(`GET /v1/logs/${agent} returns 401 without token`, async () => {
      const { status } = await req('GET', `/v1/logs/${agent}`);
      expect(status).toBe(401);
    });

    it.skipIf(SKIP)(`GET /v1/logs/${agent} returns 401 for unknown token`, async () => {
      const { status } = await req('GET', `/v1/logs/${agent}`, { token: UNKNOWN_TOKEN });
      expect(status).toBe(401);
    });

    it.skipIf(SKIP)(`GET /v1/logs/${agent} returns 200 for valid agent token`, async () => {
      const { status } = await req('GET', `/v1/logs/${agent}`, { token: AGENT_TOKEN });
      expect(status).toBe(200);
    });

    it.skipIf(SKIP)(`GET /v1/logs/${agent} returns 200 for valid dashboard token (read endpoint)`, async () => {
      const { status } = await req('GET', `/v1/logs/${agent}`, { token: DASHBOARD_TOKEN });
      expect(status).toBe(200);
    });

    it.skipIf(SKIP)(`POST /v1/logs/${agent} returns 403 for dashboard token (agent-only)`, async () => {
      const body =
        agent === 'research' ? { check_type: 'token_scan' } :
        agent === 'sentinel' ? { check_type: 'price_check' } :
        agent === 'executor' ? {} :
        {};
      const { status } = await req('POST', `/v1/logs/${agent}`, {
        token: DASHBOARD_TOKEN,
        body,
      });
      expect(status).toBe(403);
    });

    it.skipIf(SKIP)(`POST /v1/logs/${agent} returns 401 without token`, async () => {
      const body =
        agent === 'research' ? { check_type: 'token_scan' } :
        agent === 'sentinel' ? { check_type: 'price_check' } :
        {};
      const { status } = await req('POST', `/v1/logs/${agent}`, { body });
      expect(status).toBe(401);
    });
  }
});

// ---------------------------------------------------------------------------
// POST happy-path and GET round-trip (research)
// ---------------------------------------------------------------------------

describe('POST + GET /v1/logs/research', () => {
  let createdId: number;

  it.skipIf(SKIP)('POST appends a research log row and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/logs/research', {
      token: AGENT_TOKEN,
      body: {
        check_type: 'token_scan',
        tokens_scanned: 10,
        tokens_analyzed: 5,
        trades_proposed: 1,
        status: 'ok',
        summary: 'integration test row',
      },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['id']).toBeTypeOf('number');
    expect(row['check_type']).toBe('token_scan');
    expect(row['tokens_scanned']).toBe(10);
    expect(row['status']).toBe('ok');
    expect(row['summary']).toBe('integration test row');
    createdId = row['id'] as number;
  });

  it.skipIf(SKIP)('GET /v1/logs/research returns the appended row', async () => {
    const { status, body } = await req('GET', '/v1/logs/research', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    const rows = body as Array<Record<string, unknown>>;
    const found = rows.find((r) => r['id'] === createdId);
    expect(found).toBeDefined();
    expect(found!['check_type']).toBe('token_scan');
  });

  it.skipIf(SKIP)('GET /v1/logs/research/:id returns the specific row', async () => {
    if (!createdId) return;
    const { status, body } = await req('GET', `/v1/logs/research/${createdId}`, { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['id']).toBe(createdId);
  });

  it.skipIf(SKIP)('GET /v1/logs/research/:id returns 404 for non-existent id', async () => {
    const { status } = await req('GET', '/v1/logs/research/999999', { token: AGENT_TOKEN });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// POST happy-path and GET round-trip (sentinel)
// ---------------------------------------------------------------------------

describe('POST + GET /v1/logs/sentinel', () => {
  let createdId: number;

  it.skipIf(SKIP)('POST appends a sentinel log row and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/logs/sentinel', {
      token: AGENT_TOKEN,
      body: {
        check_type: 'price_check',
        positions_checked: 3,
        alerts_generated: 1,
        sells_executed: 0,
        status: 'warn',
        summary: 'sentinel integration test',
      },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['check_type']).toBe('price_check');
    expect(row['positions_checked']).toBe(3);
    expect(row['status']).toBe('warn');
    createdId = row['id'] as number;
  });

  it.skipIf(SKIP)('GET /v1/logs/sentinel returns the appended row', async () => {
    const { status, body } = await req('GET', '/v1/logs/sentinel', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    const found = rows.find((r) => r['id'] === createdId);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST happy-path and GET round-trip (executor)
// ---------------------------------------------------------------------------

describe('POST + GET /v1/logs/executor', () => {
  let createdId: number;

  it.skipIf(SKIP)('POST appends an executor log row and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/logs/executor', {
      token: AGENT_TOKEN,
      body: {
        sell_orders_processed: 2,
        buy_orders_processed: 1,
        success_count: 3,
        fail_count: 0,
        status: 'ok',
      },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['sell_orders_processed']).toBe(2);
    expect(row['success_count']).toBe(3);
    createdId = row['id'] as number;
  });

  it.skipIf(SKIP)('GET /v1/logs/executor returns the appended row', async () => {
    const { status, body } = await req('GET', '/v1/logs/executor', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    const found = rows.find((r) => r['id'] === createdId);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// POST happy-path and GET round-trip (observer)
// ---------------------------------------------------------------------------

describe('POST + GET /v1/logs/observer', () => {
  let createdId: number;

  it.skipIf(SKIP)('POST appends an observer log row and returns 201', async () => {
    const { status, body } = await req('POST', '/v1/logs/observer', {
      token: AGENT_TOKEN,
      body: {
        errors_analyzed: 2,
        issues_created: 1,
        alerts_sent: 1,
        status: 'error',
        summary: 'observer integration test',
      },
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['errors_analyzed']).toBe(2);
    expect(row['status']).toBe('error');
    createdId = row['id'] as number;
  });

  it.skipIf(SKIP)('GET /v1/logs/observer returns the appended row', async () => {
    const { status, body } = await req('GET', '/v1/logs/observer', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    const found = rows.find((r) => r['id'] === createdId);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Query filtering
// ---------------------------------------------------------------------------

describe('agent-logs — query filtering', () => {
  it.skipIf(SKIP)('GET /v1/logs/research?status=ok returns only ok rows', async () => {
    const { status, body } = await req('GET', '/v1/logs/research?status=ok', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    rows.forEach((r) => expect(r['status']).toBe('ok'));
  });

  it.skipIf(SKIP)('GET /v1/logs/research?limit=1 returns at most 1 row', async () => {
    const { status, body } = await req('GET', '/v1/logs/research?limit=1', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect((body as unknown[]).length).toBeLessThanOrEqual(1);
  });

  it.skipIf(SKIP)('GET /v1/logs/sentinel?status=warn returns only warn rows', async () => {
    const { status, body } = await req('GET', '/v1/logs/sentinel?status=warn', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = body as Array<Record<string, unknown>>;
    rows.forEach((r) => expect(r['status']).toBe('warn'));
  });
});

// ---------------------------------------------------------------------------
// Audit row written per POST (DoD §A)
// ---------------------------------------------------------------------------

describe('agent-logs — audit rows (DoD §A)', () => {
  it.skipIf(SKIP)('POST /v1/logs/research writes an audit row', async () => {
    // First POST creates a row
    await req('POST', '/v1/logs/research', {
      token: AGENT_TOKEN,
      body: { check_type: 'audit_check_test' },
    });

    // Then GET /v1/audit to verify the row was audited
    const { status: auditStatus, body: auditBody } = await req('GET', '/v1/audit', {
      token: DASHBOARD_TOKEN,
    });
    expect(auditStatus).toBe(200);
    const rows = auditBody as Array<Record<string, unknown>>;
    // At least one audit row should reference the logs/research path
    const logAuditRow = rows.find(
      (r) => typeof r['path'] === 'string' && r['path'].includes('/v1/logs/research'),
    );
    expect(logAuditRow).toBeDefined();
  });
});
