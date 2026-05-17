/**
 * Integration tests for `cclaw orders history`, `cclaw orders cancel`, and
 * `cclaw orders retry` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers:
 *   orders history  — alias for GET /v1/orders with default --limit 20
 *   orders cancel   — POST /v1/orders/:id/cancel
 *   orders retry    — POST /v1/orders/:id/retry
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7902
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const REPO_ROOT = resolve(__dirname, '../../..');
const CCLAW_BIN = resolve(REPO_ROOT, 'sdk/cclaw/dist/index.js');

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';

const PORT = 7902;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-orders-history-test',
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

let api: StartApiResult;

beforeAll(async () => {
  if (!ENABLED) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-orders-history-integration',
  });
}, 25_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
});

function cclawEnv(token = AGENT_TOKEN): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCLAW_API_BASE: BASE,
    CCLAW_API_TOKEN: token,
  };
}

function cclaw(args: string[], token = AGENT_TOKEN): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CCLAW_BIN, ...args], {
      encoding: 'utf8',
      env: cclawEnv(token),
      timeout: 10_000,
    });
    return { exitCode: 0, stdout, stderr: '' };
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException & { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
    };
  }
}

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

/** Propose a test order and return its ID. */
async function proposeOrder(): Promise<string> {
  const { body } = await req('POST', '/v1/orders', {
    token: AGENT_TOKEN,
    body: {
      action: 'buy',
      symbol: 'TEST',
      address: '0x' + 'a'.repeat(40),
      chain: 'base',
      amount: '100',
    },
  });
  return (body as Record<string, unknown>)['id'] as string;
}

/**
 * Propose a test order, then approve it, returning the approved order ID.
 * Cancel is only allowed from 'approved' or 'failed' state (not 'pending').
 * State machine: pending → approved → cancelled
 */
async function proposeAndApproveOrder(): Promise<string> {
  const id = await proposeOrder();
  await req('POST', `/v1/orders/${id}/approve`, {
    token: AGENT_TOKEN,
    body: { by: 'test' },
  });
  return id;
}

// ---------------------------------------------------------------------------
// orders history — alias for GET /v1/orders with default limit 20
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw orders history', () => {
  it('exits 0 and returns { data: [...] } shape', () => {
    const { exitCode, stdout, stderr } = cclaw(['orders', 'history']);
    expect(exitCode, `orders history failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    // GET /v1/orders returns { data: [], meta: {} }
    expect(Array.isArray(parsed['data'])).toBe(true);
  });

  it('exits 0 with --limit 5', () => {
    const { exitCode, stdout, stderr } = cclaw(['orders', 'history', '--limit', '5']);
    expect(exitCode, `orders history --limit failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed['data'])).toBe(true);
  });

  it('exits 0 with --status filter', () => {
    const { exitCode, stdout, stderr } = cclaw(['orders', 'history', '--status', 'pending']);
    expect(exitCode, `orders history --status failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed['data'])).toBe(true);
  });

  it('exits 0 with --action filter', () => {
    const { exitCode, stdout, stderr } = cclaw(['orders', 'history', '--action', 'buy']);
    expect(exitCode, `orders history --action failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed['data'])).toBe(true);
  });

  it('appears in history after proposing an order', async () => {
    const id = await proposeOrder();
    const { exitCode, stdout, stderr } = cclaw(['orders', 'history']);
    expect(exitCode, `orders history failed after propose: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const data = parsed['data'] as Array<Record<string, unknown>>;
    const found = data.find((o) => o['id'] === id);
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// orders cancel
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw orders cancel', () => {
  it('exits 0 and transitions order to cancelled status (from approved state)', async () => {
    // Cancel is only allowed from 'approved' (or 'failed') — not from 'pending'.
    // State machine: pending → approved → cancelled
    const id = await proposeAndApproveOrder();
    const { exitCode, stdout, stderr } = cclaw([
      'orders', 'cancel',
      '--id', id,
      '--reason', 'test cancel',
    ]);
    expect(exitCode, `orders cancel failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['status']).toBe('cancelled');
  });

  it('exits 1 for a pending order (409 — cancel only valid from approved/failed)', async () => {
    const id = await proposeOrder();
    const { exitCode } = cclaw(['orders', 'cancel', '--id', id]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for unknown ID (404)', () => {
    const { exitCode } = cclaw(['orders', 'cancel', '--id', 'does-not-exist-xyz-000']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['orders', 'cancel']);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row for cancel (DoD §C)', async () => {
    // Must be in 'approved' state to cancel
    const id = await proposeAndApproveOrder();
    await req('POST', `/v1/orders/${id}/cancel`, {
      token: AGENT_TOKEN,
      body: { reason: 'audit test' },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/cancel') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(200);
  });

  it('exits 1 for dashboard token (write forbidden)', async () => {
    const id = await proposeOrder();
    const { exitCode } = cclaw(['orders', 'cancel', '--id', id], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// orders retry
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw orders retry', () => {
  it('exits 1 for a pending order (409 — only failed orders can be retried)', async () => {
    // A fresh proposed order is in "pending" state, not "failed".
    // Retry should return 409 Invalid state transition.
    const id = await proposeOrder();
    const { exitCode } = cclaw(['orders', 'retry', '--id', id]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for unknown ID (404)', () => {
    const { exitCode } = cclaw(['orders', 'retry', '--id', 'unknown-order-xyz']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['orders', 'retry']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', async () => {
    const id = await proposeOrder();
    const { exitCode } = cclaw(['orders', 'retry', '--id', id], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — auth and state-machine assertions
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/orders — auth assertions', () => {
  it('returns 200 for agent token', async () => {
    const { status } = await req('GET', '/v1/orders', { token: AGENT_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 200 for dashboard token (read-only allowed)', async () => {
    const { status } = await req('GET', '/v1/orders', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/orders');
    expect(status).toBe(401);
  });
});

describe.skipIf(!ENABLED)('POST /v1/orders/:id/cancel — state-machine assertions', () => {
  it('returns 409 when cancelling from pending state (only approved/failed can be cancelled)', async () => {
    const id = await proposeOrder();
    // Attempt to cancel a pending order — should 409 (invalid transition)
    const { status } = await req('POST', `/v1/orders/${id}/cancel`, {
      token: AGENT_TOKEN,
      body: {},
    });
    expect(status).toBe(409);
  });

  it('returns 409 when cancelling an already-cancelled order', async () => {
    const id = await proposeAndApproveOrder();
    // Cancel once (approved → cancelled)
    await req('POST', `/v1/orders/${id}/cancel`, { token: AGENT_TOKEN, body: {} });
    // Cancel again — should 409 (invalid transition from cancelled)
    const { status } = await req('POST', `/v1/orders/${id}/cancel`, {
      token: AGENT_TOKEN,
      body: {},
    });
    expect(status).toBe(409);
  });

  it('returns 409 when retrying a pending order (only failed orders can be retried)', async () => {
    const id = await proposeOrder();
    const { status } = await req('POST', `/v1/orders/${id}/retry`, {
      token: AGENT_TOKEN,
      body: {},
    });
    expect(status).toBe(409);
  });
});
