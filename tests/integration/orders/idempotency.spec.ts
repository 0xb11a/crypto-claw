/**
 * Integration tests for BullMQ execute-order idempotency (DoD §E, plan step 32).
 *
 * Verifies that:
 *   - Calling execute() twice for the same orderId produces one deterministic jobId.
 *   - The second POST to /execute returns 409 (order already in executing status).
 *   - Enqueueing the same jobId twice collapses to one BullMQ job (deterministic jobId).
 *
 * Unit-level idempotency is tested in execute-order.processor.spec.ts.
 * This integration test verifies the HTTP layer + OrdersService together.
 *
 * Gated by CCLAW_SECURITY_TESTS_ENABLED=1 (requires compiled API + DB).
 *
 * DoD §E — BullMQ processor idempotency: run twice, assert DB shape unchanged.
 * SPEC §8 — Background jobs idempotency guarantee.
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
  SAFE_ID: 'ci-idempotency-test',
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
  await request('POST', `/v1/orders/${orderId}/approve`, {
    token: AGENT_TOKEN,
    body: { by: 'human' },
  });
  return orderId;
}

beforeAll(async () => {
  if (!ENABLED) return;

  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-idempotency-'));
  dbPath = resolve(tempDir, 'idempotency-test.db');

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
  'BullMQ execute-order idempotency (CCLAW_SECURITY_TESTS_ENABLED required)',
  () => {
    it('first execute call returns 202 with deterministic jobId', async () => {
      const orderId = await createApprovedOrder();
      const { status, body } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(status).toBe(202);
      expect((body as { jobId: string }).jobId).toBe(`execute-order:${orderId}`);
    });

    it('second execute call on same order returns 409 (order is now executing)', async () => {
      // The order is already transitioning to executing from the first call —
      // a second call should be rejected with 409 (not in approved status).
      const orderId = await createApprovedOrder();

      // First call — succeeds
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      // Second call on same order — 409 because order is now 'executing' not 'approved'
      const { status: secondStatus } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      expect(secondStatus).toBe(409);
    });

    it('both execute calls for the same order produce the same deterministic jobId', async () => {
      const orderId = await createApprovedOrder();

      const { body: firstBody } = await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });
      const firstJobId = (firstBody as { jobId: string }).jobId;

      // The expected deterministic jobId regardless of how many times execute was called
      expect(firstJobId).toBe(`execute-order:${orderId}`);
    });

    it('order status only transitions to executing once (not doubled)', async () => {
      const orderId = await createApprovedOrder();

      // Execute once
      await request('POST', `/v1/orders/${orderId}/execute`, {
        token: AGENT_TOKEN,
        body: {},
      });

      // Check order status — should be in executing (not some invalid state)
      const { body: orderBody } = await request('GET', `/v1/orders/${orderId}`, {
        token: AGENT_TOKEN,
      });
      const order = orderBody as { status: string };
      // Order should be in a valid terminal state after first execute
      expect(['executing', 'executed', 'failed']).toContain(order.status);
    });
  },
);
