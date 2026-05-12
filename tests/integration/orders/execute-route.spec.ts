/**
 * Integration tests for POST /v1/orders/:id/execute (SPEC §5, P1c-i).
 *
 * Verifies the full request lifecycle against a real running API:
 *   - 401 without token
 *   - 403 for dashboard role
 *   - 202 for agent role on approved order (real mode)
 *   - 409 when order is not in approved status
 *   - audit row written (service_audit via @Audited())
 *   - response shape: { jobId, orderId, status }
 *
 * Self-spawns the compiled API binary (same pattern as auth.spec.ts).
 * Gated by CCLAW_SECURITY_TESTS_ENABLED=1 to avoid port-conflict issues
 * when run in parallel with other integration tests.
 *
 * EXECUTOR_STUB_MODE=1 required so the worker can spawn the executor in CI.
 * BullMQ enqueue is real; the worker processes the job asynchronously.
 *
 * DoD §A — test that fails before / passes after (per plan step 31).
 * DoD §C — API change: new route covered with request-lifecycle test.
 * DoD §F — security: 401/403 enforcement on execute route.
 * SPEC §9.5 — audit row written on every non-GET write.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(__dirname, '../../..');
const API_DIST = resolve(REPO_ROOT, 'apps/api/dist/main.js');
const PRISMA_BIN = resolve(REPO_ROOT, 'node_modules/.bin/prisma');

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-execute-route-test',
  REDIS_URL: process.env['REDIS_URL'] ?? 'redis://localhost:6379',
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
  EXECUTOR_STUB_MODE: '1',
  PAPER_MODE: 'false',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

let apiProcess: ReturnType<typeof spawn> | null = null;
let tempDir: string;
let dbPath: string;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const base = `http://127.0.0.1:7878`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const response = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body !== undefined ? { body: JSON.stringify(opts.body) } : {}),
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/**
 * Create an order and approve it so it's ready for execute.
 * Returns the order ID.
 */
async function createApprovedOrder(): Promise<string> {
  const { body: proposed } = await request('POST', '/v1/orders', {
    token: AGENT_TOKEN,
    body: {
      action: 'buy',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      amount: '100',
      tier: 'conviction',
      entry_price: 2000,
      stop_loss: 1600,
      take_profit_levels: [2500, 3000],
      analysis_score: 85,
      risk_score: 20,
    },
  });
  const orderId = (proposed as { id: string }).id;

  // Approve the order
  await request('POST', `/v1/orders/${orderId}/approve`, {
    token: AGENT_TOKEN,
    body: { by: 'human' },
  });

  return orderId;
}

// ---------------------------------------------------------------------------
// Boot API
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!ENABLED) return;

  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-execute-route-'));
  dbPath = resolve(tempDir, 'execute-route-test.db');

  execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
    },
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });

  await new Promise<void>((resolve, reject) => {
    apiProcess = spawn('node', [API_DIST], {
      env: {
        ...BASE_ENV,
        DB_PATH: dbPath,
        DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const timeout = setTimeout(() => {
      if (!started) reject(new Error('API failed to start within 15s'));
    }, 15000);

    apiProcess.stdout?.on('data', (d: Buffer) => {
      if (d.toString().includes('api ready on')) {
        started = true;
        clearTimeout(timeout);
        resolve();
      }
    });

    apiProcess.on('exit', (code) => {
      if (!started) {
        clearTimeout(timeout);
        reject(new Error(`API exited with code ${String(code)} before becoming ready`));
      }
    });
  });
}, 20000);

afterAll(async () => {
  if (!ENABLED) return;
  if (apiProcess) {
    apiProcess.kill('SIGTERM');
    await new Promise<void>((r) => apiProcess!.on('exit', () => r()));
  }
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)(
  'POST /v1/orders/:id/execute — auth + lifecycle (CCLAW_SECURITY_TESTS_ENABLED required)',
  () => {
    it('returns 401 when Authorization header is absent', async () => {
      const { status } = await request('POST', '/v1/orders/fake-order-id/execute', { body: {} });
      expect(status).toBe(401);
    });

    it('returns 403 for dashboard role (agent-only route)', async () => {
      const orderId = await createApprovedOrder();
      const { status } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: DASHBOARD_TOKEN,
        body: {},
      });
      expect(status).toBe(403);
    });

    it('returns 404 for a non-existent order ID', async () => {
      const { status } = await request('POST', '/v1/orders/does-not-exist-xyz/execute', {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(status).toBe(404);
    });

    it('returns 409 when order is not in approved status (pending order)', async () => {
      // Propose but do NOT approve — order stays in pending status
      const { body: proposed } = await request('POST', '/v1/orders', {
        token: AGENT_TOKEN,
        body: {
          action: 'buy',
          symbol: 'ETH',
          address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
          chain: 'base',
          amount: '100',
          tier: 'conviction',
          entry_price: 2000,
          stop_loss: 1600,
          take_profit_levels: [2500, 3000],
          analysis_score: 85,
          risk_score: 20,
        },
      });
      const pendingOrderId = (proposed as { id: string }).id;

      const { status } = await request('POST', `/v1/orders/${pendingOrderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(status).toBe(409);
    });

    it('returns 202 with enqueued response for an approved order in real mode', async () => {
      const orderId = await createApprovedOrder();
      const { status, body } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      expect(status).toBe(202);
      const responseBody = body as { jobId: string; orderId: string; status: string };
      expect(responseBody.status).toBe('enqueued');
      expect(responseBody.orderId).toBe(orderId);
      expect(responseBody.jobId).toBe(`execute-order:${orderId}`);
    });

    it('response jobId uses deterministic pattern execute-order:<id>', async () => {
      const orderId = await createApprovedOrder();
      const { body } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      const responseBody = body as { jobId: string };
      expect(responseBody.jobId).toMatch(/^execute-order:/);
    });

    it('order transitions to executing status after execute call', async () => {
      const orderId = await createApprovedOrder();
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      // Poll the order status — it should be in 'executing' (or 'executed'/'failed' if worker is fast)
      const { body: orderBody } = await request('GET', `/v1/orders/${orderId}`, {
        token: AGENT_TOKEN,
      });
      const order = orderBody as { status: string };
      expect(['executing', 'executed', 'failed']).toContain(order.status);
    });

    it('writes an audit row via @Audited() for the execute call', async () => {
      const orderId = await createApprovedOrder();
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      // Query the audit log for a row matching this order's execute call
      const { body: auditBody } = await request('GET', '/v1/system/audit', {
        token: AGENT_TOKEN,
      });
      const auditRows = (auditBody as { data: Array<{ path: string; method: string }> }).data;
      const executeAuditRow = auditRows.find(
        (row) => row.path.includes(orderId) && row.path.includes('execute') && row.method === 'POST',
      );
      expect(executeAuditRow).toBeDefined();
    });
  },
);
