/**
 * Integration tests for paper-mode execute short-circuit (plan step 33).
 *
 * Verifies that in PAPER_MODE=true:
 *   - POST /execute returns 202 with { jobId: null, orderId, status: 'paper_executed' }
 *   - Order transitions to 'executed' synchronously (no BullMQ enqueue)
 *   - A paper receipt is persisted
 *   - No BullMQ job is enqueued (verified by absence of jobId)
 *
 * Gated by CCLAW_SECURITY_TESTS_ENABLED=1 (requires compiled API + DB).
 *
 * DoD §A — test for paper-mode short-circuit path.
 * DoD §C — paper mode execute lifecycle test.
 * SPEC §4 (paper mode bypasses executor).
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

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-paper-mode-test',
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
  // Paper mode ON — executor not involved
  PAPER_MODE: 'true',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

let apiProcess: ReturnType<typeof spawn> | null = null;
let tempDir: string;
let dbPath: string;

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

async function createApprovedOrder(): Promise<string> {
  const { body: proposed } = await request('POST', '/v1/orders', {
    token: AGENT_TOKEN,
    body: {
      action: 'buy',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      amount: '500',
      tier: 'conviction',
      entry_price: 2000,
      stop_loss: 1600,
      take_profit_levels: [2500, 3000],
      analysis_score: 85,
      risk_score: 20,
    },
  });
  const orderId = (proposed as { id: string }).id;
  await request('POST', `/v1/orders/${orderId}/approve`, {
    token: AGENT_TOKEN,
    body: { by: 'human' },
  });
  return orderId;
}

beforeAll(async () => {
  if (!ENABLED) return;

  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-paper-mode-'));
  dbPath = resolve(tempDir, 'paper-mode-test.db');

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

describe.skipIf(!ENABLED)(
  'POST /v1/orders/:id/execute in PAPER_MODE=true (CCLAW_SECURITY_TESTS_ENABLED required)',
  () => {
    it('returns 202 with status paper_executed (not enqueued)', async () => {
      const orderId = await createApprovedOrder();
      const { status, body } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(status).toBe(202);
      const responseBody = body as { jobId: unknown; orderId: string; status: string };
      expect(responseBody.status).toBe('paper_executed');
      expect(responseBody.orderId).toBe(orderId);
    });

    it('returns jobId: null in paper mode (no BullMQ enqueue)', async () => {
      const orderId = await createApprovedOrder();
      const { body } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      const responseBody = body as { jobId: unknown };
      expect(responseBody.jobId).toBeNull();
    });

    it('order is in executed status synchronously after paper execute', async () => {
      // Paper mode short-circuits synchronously — no BullMQ job, no worker.
      // The order transitions approved → executing → executed within the same request.
      const orderId = await createApprovedOrder();
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      const { body: orderBody } = await request('GET', `/v1/orders/${orderId}`, {
        token: AGENT_TOKEN,
      });
      const order = orderBody as { status: string };
      // Must be 'executed' synchronously (not 'executing') because paper mode is synchronous
      expect(order.status).toBe('executed');
    });

    it('paper receipt is persisted after execute', async () => {
      const orderId = await createApprovedOrder();
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      // Check that a receipt exists for this order.
      // The DTO field is orderId (camelCase) and mode=paper routes to paper_receipts table.
      const { body: receiptsBody } = await request(
        'GET',
        `/v1/receipts?mode=paper&orderId=${orderId}`,
        { token: AGENT_TOKEN },
      );
      const receipts = (receiptsBody as { data: Array<{ order_id: string; mode: string }> }).data;
      const paperReceipt = receipts.find((r) => r.order_id === orderId && r.mode === 'paper');
      expect(paperReceipt).toBeDefined();
    });

    it('409 when trying to execute an already-executed order in paper mode', async () => {
      const orderId = await createApprovedOrder();
      // First execute — succeeds
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      // Second execute — 409 because order is now 'executed' not 'approved'
      const { status } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(status).toBe(409);
    });
  },
);
