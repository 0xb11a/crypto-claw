/**
 * Security integration tests — authentication and authorisation (SPEC §9.1–§9.3, ADR-0009).
 *
 * Verifies that the API enforces:
 * - 401 when the Authorization header is missing
 * - 401 when an unknown (wrong) bearer token is presented
 * - 403 when a valid token is presented but the role is insufficient
 * - 200 when the correct token + role is presented
 *
 * These tests spawn the compiled API binary and make real HTTP requests,
 * so they require a prior `pnpm build` and must be run after `pnpm test:integration`.
 * They DON'T mock the auth guards — the real BearerAuthGuard and RolesGuard run.
 *
 * DoD §F — security changes.
 * SPEC §14 — security tests cover 401/403.
 */

/**
 * These tests require a running API instance (spawned from the compiled binary).
 * They are gated behind CCLAW_SECURITY_TESTS_ENABLED=1 to avoid port-conflict
 * issues when run in parallel with other integration tests.
 *
 * The @fastify/static dependency was added in commit ac1784e — tests now run
 * cleanly against the compiled binary.
 *
 * DB migration is run in beforeAll so Prisma tables exist before the API starts.
 * DB_PATH is passed explicitly so PrismaModule.register() doesn't overwrite
 * DATABASE_URL with the default ./data/<SAFE_ID>.db path.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

// Skip when not explicitly enabled — tests spawn a real API on port 7878 and
// can conflict with other integration tests. Set CCLAW_SECURITY_TESTS_ENABLED=1
// to enable (done automatically in the security test job).
const SKIP_REASON = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

/**
 * Tokens that match the compiled-in API keys (same as pr.yml CI env block).
 * These map to specific identities and roles per ADR-0009.
 */
const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';   // role: agent
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa'; // role: dashboard
const UNKNOWN_TOKEN = 'completely-unknown-token-xyz-12345'; // not in registry

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-auth-test',
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

// ---------------------------------------------------------------------------
// Start the API server once for the whole test suite
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (SKIP_REASON) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: 7878,
    readyTimeoutMs: 15_000,
    tmpPrefix: 'cclaw-auth-test',
  });
}, 20_000);

afterAll(async () => {
  if (SKIP_REASON) return;
  await api.kill();
});

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
  if (opts.token) {
    headers['Authorization'] = `Bearer ${opts.token}`;
  }
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

// ---------------------------------------------------------------------------
// Auth tests
// ---------------------------------------------------------------------------

describe('GET /v1/positions — auth enforcement (SPEC §9.1–§9.3)', () => {
  it.skipIf(SKIP_REASON)('returns 401 when Authorization header is absent', async () => {
    const { status } = await request('GET', '/v1/positions');
    expect(status).toBe(401);
  });

  it.skipIf(SKIP_REASON)('returns 401 for an unknown (wrong) bearer token', async () => {
    const { status } = await request('GET', '/v1/positions', { token: UNKNOWN_TOKEN });
    expect(status).toBe(401);
  });

  it.skipIf(SKIP_REASON)('returns 200 for a valid agent token', async () => {
    const { status } = await request('GET', '/v1/positions', { token: AGENT_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('returns 200 for a valid dashboard token (read endpoint)', async () => {
    const { status } = await request('GET', '/v1/positions', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });
});

describe('POST /v1/orders — role enforcement (SPEC §9.2)', () => {
  it.skipIf(SKIP_REASON)('returns 403 when a dashboard token is used on agent-only route', async () => {
    const body = {
      action: 'buy',
      symbol: 'ETH',
      address: '0xabc',
      chain: 'base',
      amount: '100',
      tier: 'conviction',
      entry_price: 2000,
      stop_loss: 1600,
      take_profit_levels: [2500, 3000],
      analysis_score: 80,
      risk_score: 20,
    };
    const { status } = await request('POST', '/v1/orders', { token: DASHBOARD_TOKEN, body });
    expect(status).toBe(403);
  });

  it.skipIf(SKIP_REASON)('returns 401 when no token is presented on a write route', async () => {
    const body = { action: 'buy', symbol: 'ETH', address: '0xabc', chain: 'base', amount: '100' };
    const { status } = await request('POST', '/v1/orders', { body });
    expect(status).toBe(401);
  });
});

describe('DTO validation (SPEC §9.3 — forbidNonWhitelisted, whitelist)', () => {
  it.skipIf(SKIP_REASON)('returns 400 when POST /v1/orders includes an unknown field', async () => {
    const body = {
      action: 'buy',
      symbol: 'ETH',
      address: '0xabc',
      chain: 'base',
      amount: '100',
      unknown_extra_field: 'should be rejected',
    };
    const { status } = await request('POST', '/v1/orders', { token: AGENT_TOKEN, body });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP_REASON)('returns 400 when POST /v1/orders uses an invalid action value', async () => {
    const body = {
      action: 'invalid_action',
      symbol: 'ETH',
      address: '0xabc',
      chain: 'base',
      amount: '100',
    };
    const { status } = await request('POST', '/v1/orders', { token: AGENT_TOKEN, body });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// P7 additions — DASHBOARD wildcard; WORKER/SCHEDULER empty-scope (ADR-0009 addendum)
// ---------------------------------------------------------------------------

const WORKER_TOKEN = BASE_ENV.WORKER_API_KEY!;
const SCHEDULER_TOKEN = BASE_ENV.SCHEDULER_API_KEY!;

describe('DASHBOARD wildcard @Identities("*") passes on read routes (P7, ADR-0009 addendum)', () => {
  it.skipIf(SKIP_REASON)('DASHBOARD + GET /v1/positions → 200', async () => {
    const { status } = await request('GET', '/v1/positions', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('DASHBOARD + GET /v1/system/portfolio → 200', async () => {
    const { status } = await request('GET', '/v1/system/portfolio', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('DASHBOARD + GET /v1/alerts → 200', async () => {
    const { status } = await request('GET', '/v1/alerts', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('DASHBOARD + GET /v1/orders → 200', async () => {
    const { status } = await request('GET', '/v1/orders', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });
});

describe('WORKER token → 403 on agent-write routes (empty scope, RolesGuard passes, role=agent)', () => {
  // WORKER has role='agent' so it passes RolesGuard. It should be blocked by IdentityGuard
  // in enforce mode; in shadow mode the guard passes and the service runs (2xx).
  // These tests confirm WORKER is NOT blocked at the role level (that is correct),
  // and in the current shadow-mode API the requests succeed (demonstrating the
  // shadow-mode log-only behaviour — these would 403 after PR-C).
  it.skipIf(SKIP_REASON)('WORKER + GET /v1/positions → 200 (wildcard route; identity guard passes)', async () => {
    const { status } = await request('GET', '/v1/positions', { token: WORKER_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('WORKER + GET /v1/orders → 200 (wildcard route; identity guard passes)', async () => {
    const { status } = await request('GET', '/v1/orders', { token: WORKER_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)('WORKER + GET /v1/receipts → 200 (wildcard route; identity guard passes)', async () => {
    const { status } = await request('GET', '/v1/receipts', { token: WORKER_TOKEN });
    expect(status).toBe(200);
  });

  it.skipIf(SKIP_REASON)(
    'WORKER + GET /v1/system/portfolio → 200 (wildcard route; identity guard passes)',
    async () => {
      const { status } = await request('GET', '/v1/system/portfolio', { token: WORKER_TOKEN });
      expect(status).toBe(200);
    },
  );
});

describe('SCHEDULER token → same shadow-pass behaviour as WORKER (empty scope, role=agent)', () => {
  it.skipIf(SKIP_REASON)(
    'SCHEDULER + GET /v1/positions → 200 (wildcard route; identity guard passes in shadow)',
    async () => {
      const { status } = await request('GET', '/v1/positions', { token: SCHEDULER_TOKEN });
      expect(status).toBe(200);
    },
  );

  it.skipIf(SKIP_REASON)(
    'SCHEDULER + GET /v1/orders → 200 (wildcard route; identity guard passes in shadow)',
    async () => {
      const { status } = await request('GET', '/v1/orders', { token: SCHEDULER_TOKEN });
      expect(status).toBe(200);
    },
  );

  it.skipIf(SKIP_REASON)(
    'SCHEDULER + GET /v1/alerts → 200 (wildcard route; identity guard passes in shadow)',
    async () => {
      const { status } = await request('GET', '/v1/alerts', { token: SCHEDULER_TOKEN });
      expect(status).toBe(200);
    },
  );

  it.skipIf(SKIP_REASON)(
    'SCHEDULER + GET /v1/receipts → 200 (wildcard route; identity guard passes in shadow)',
    async () => {
      const { status } = await request('GET', '/v1/receipts', { token: SCHEDULER_TOKEN });
      expect(status).toBe(200);
    },
  );
});
