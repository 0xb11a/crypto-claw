/**
 * Identity-tightening E2E tests — P7 PR-B (SPEC §9.2, ADR-0009 addendum, ADR-0029).
 *
 * Full-stack enforce-mode assertion: spawns apps-api with AUTHZ_SHADOW_MODE=0
 * (enforce) and verifies that per-identity token plumbing produces the correct
 * 201/403 outcomes on POST /v1/orders.
 *
 * Scenario (per plan step 24):
 *   - RESEARCH token → POST /v1/orders (BUY) → 201   (RESEARCH is in @Identities allowlist)
 *   - SENTINEL token → POST /v1/orders (SELL)→ 201   (SENTINEL is in @Identities allowlist)
 *   - EXECUTOR token → POST /v1/orders (BUY) → 403   (EXECUTOR is NOT in allowlist)
 *
 * Architectural note on PR-B gap (documented in runbook §16.5):
 *   LLM agents spawned by the OpenClaw gateway via `openclaw cron` / `openclaw agent`
 *   inherit CCLAW_API_TOKEN=$LOOP_API_KEY from the container env. Only the explicit
 *   cclaw calls in entrypoint.sh background loops (alert sends, emergency scripts)
 *   carry the per-agent token. This test validates the token-plumbing contract at the
 *   HTTP layer (IdentityGuard enforce-mode) independently of the OpenClaw launcher.
 *
 * Compose-smoke extension note:
 *   The plan calls for a compose-smoke CI assertion that a RESEARCH-tokened
 *   POST /v1/orders returns 201. That assertion is tracked as a separate CI TODO
 *   because the compose-smoke job runs against the production image (which needs
 *   CCLAW_API_TOKEN passthrough through the gateway env). The env plumbing is
 *   verified here at unit level; the compose job extension is deferred until the
 *   crypto-claw gateway container is part of the smoke-test scope.
 *
 * DoD §F — security changes, new auth surface.
 * DoD §A — new spec per code change.
 * SPEC §14 — security tests under tests/integration/security/.
 *
 * Test conventions:
 *   - Gated behind CCLAW_SECURITY_TESTS_ENABLED=1.
 *   - Single API instance in enforce mode (AUTHZ_SHADOW_MODE=0) on port 7917.
 *   - No mocks of auth guards; real IdentityGuard runs.
 *   - Requires prior `pnpm build` (spawns compiled apps/api/dist/main.js).
 *
 * TODO for tester:
 *   - Verify that SENTINEL token on POST /v1/orders with action=buy emits a service-layer
 *     ForbiddenException (OrdersService.propose identity assertion, plan [OPEN-P7-2]).
 *     That assertion is in OrdersService, not the guard — the guard 201s SENTINEL, then
 *     the service may throw. Capture the exact status code (could be 403 or another) when
 *     P7 PR-C lands the service-layer check.
 *   - Verify compose-smoke CI job: RESEARCH-tokened POST /v1/orders from inside the
 *     crypto-claw gateway container returns 201 (validates docker-compose env plumbing).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

// ---------------------------------------------------------------------------
// Gate — skip everything when not explicitly enabled
// ---------------------------------------------------------------------------

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';
const SKIP = !ENABLED;

// ---------------------------------------------------------------------------
// Token constants (same values as BASE_ENV below)
// ---------------------------------------------------------------------------

const RESEARCH_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const SENTINEL_TOKEN = 'ci-sentinel-key-aaaaaaaaaaaaaaaa';
const EXECUTOR_TOKEN = 'ci-executor-key-aaaaaaaaaaaaaaaa';
const LOOP_TOKEN = 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa';

// ---------------------------------------------------------------------------
// Shared base env — enforce mode (AUTHZ_SHADOW_MODE=0)
// ---------------------------------------------------------------------------

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-identity-e2e-test',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: RESEARCH_TOKEN,
  SENTINEL_API_KEY: SENTINEL_TOKEN,
  EXECUTOR_API_KEY: EXECUTOR_TOKEN,
  OBSERVER_API_KEY: 'ci-observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: LOOP_TOKEN,
  WORKER_API_KEY: 'ci-worker-key-aaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'ci-scheduler-key-aaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'ci-dashboard-key-aaaaaaaaaaaaaaaa',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-openai-dummy',
  NODE_ENV: 'test',
  PRISMA_DISABLE_DOTENV: '1',
  SAFE_SIGNER_KEY: '',
  SQUADS_SIGNER_KEY: '',
  // Enforce mode — IdentityGuard throws 403 on deny (not shadow-log-and-pass).
  AUTHZ_SHADOW_MODE: '0',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

// ---------------------------------------------------------------------------
// Minimum valid ProposeOrderDto body for POST /v1/orders
// ---------------------------------------------------------------------------

const BUY_ORDER_BODY = {
  action: 'buy',
  symbol: 'ETH',
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  chain: 'base',
  amount: '100',
  tier: 'conviction',
  entry_price: 2000,
  stop_loss: 1600,
  take_profit_levels: [2500, 3000],
  analysis_score: 80,
  risk_score: 20,
};

const SELL_ORDER_BODY = {
  action: 'sell',
  symbol: 'ETH',
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  chain: 'base',
  amount: '100',
  reason: 'stop_loss',
  urgency: 'immediate',
};

// ---------------------------------------------------------------------------
// API instance
// ---------------------------------------------------------------------------

let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: 7917,
    readyTimeoutMs: 30_000,
    tmpPrefix: 'cclaw-identity-e2e',
  });
}, 40_000);

afterAll(async () => {
  if (SKIP) return;
  await api?.kill();
});

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function req(
  method: string,
  path: string,
  opts: { token?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const response = await fetch(`${api.url}${path}`, {
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
// Full-stack enforce-mode: POST /v1/orders identity matrix
// ---------------------------------------------------------------------------

describe('Full-stack enforce-mode: POST /v1/orders identity allowlist', () => {
  /**
   * POST /v1/orders has @Identities('RESEARCH', 'SENTINEL', 'LOOP').
   * In enforce mode (AUTHZ_SHADOW_MODE=0) a non-matching identity throws 403.
   */

  it.skipIf(SKIP)(
    'RESEARCH token → POST /v1/orders (BUY) → 201 (RESEARCH in allowlist)',
    async () => {
      const { status } = await req('POST', '/v1/orders', {
        token: RESEARCH_TOKEN,
        body: BUY_ORDER_BODY,
      });
      // 201 = IdentityGuard passed, RolesGuard passed, service created the order.
      expect(status).toBe(201);
    },
  );

  it.skipIf(SKIP)(
    'SENTINEL token → POST /v1/orders (SELL) → 201 (SENTINEL in allowlist)',
    async () => {
      const { status } = await req('POST', '/v1/orders', {
        token: SENTINEL_TOKEN,
        body: SELL_ORDER_BODY,
      });
      // 201 = IdentityGuard passed (SENTINEL is in allowlist), order created.
      // Note: if OrdersService.propose() adds a service-layer identity check
      // (plan [OPEN-P7-2]: SENTINEL && action!=='sell' → throw), the status
      // for a buy from SENTINEL would be different. This test uses a sell body
      // to avoid that conflict and purely test the guard layer.
      expect(status).toBe(201);
    },
  );

  it.skipIf(SKIP)(
    'EXECUTOR token → POST /v1/orders (BUY) → 403 (EXECUTOR NOT in allowlist)',
    async () => {
      const { status, body } = await req('POST', '/v1/orders', {
        token: EXECUTOR_TOKEN,
        body: BUY_ORDER_BODY,
      });
      // 403 = IdentityGuard threw ForbiddenException in enforce mode.
      // EXECUTOR is not in @Identities('RESEARCH', 'SENTINEL', 'LOOP').
      expect(status).toBe(403);
      // There should be some error body present (NestJS ForbiddenException).
      expect(body).toBeDefined();
      expect(body).not.toBeNull();
    },
  );

  it.skipIf(SKIP)(
    'LOOP token → POST /v1/orders (BUY) → 201 (LOOP in allowlist — background-loop class)',
    async () => {
      const { status } = await req('POST', '/v1/orders', {
        token: LOOP_TOKEN,
        body: BUY_ORDER_BODY,
      });
      // LOOP is explicitly in the allowlist — background loops (paper-seed, memory-backup)
      // and LLM-agent-internal cclaw calls use this identity.
      expect(status).toBe(201);
    },
  );
});

// ---------------------------------------------------------------------------
// Positive control: enforce mode passes correctly-identified requests on other routes
// ---------------------------------------------------------------------------

describe('Enforce-mode positive controls (non-orders routes)', () => {
  it.skipIf(SKIP)(
    'EXECUTOR token → POST /v1/logs/executor → 201 (EXECUTOR in executor-log allowlist)',
    async () => {
      const { status } = await req('POST', '/v1/logs/executor', {
        token: EXECUTOR_TOKEN,
        body: { check_type: 'e2e_positive_control', summary: 'enforce-mode e2e test' },
      });
      // EXECUTOR is in @Identities allowlist for POST /v1/logs/executor
      expect(status).toBe(201);
    },
  );

  it.skipIf(SKIP)(
    'RESEARCH token → POST /v1/logs/executor → 403 (RESEARCH NOT in executor-log allowlist)',
    async () => {
      const { status } = await req('POST', '/v1/logs/executor', {
        token: RESEARCH_TOKEN,
        body: { check_type: 'e2e_negative_control' },
      });
      // RESEARCH is not in @Identities allowlist for POST /v1/logs/executor
      expect(status).toBe(403);
    },
  );

  it.skipIf(SKIP)(
    'SENTINEL token → POST /v1/logs/executor → 403 (SENTINEL NOT in executor-log allowlist)',
    async () => {
      const { status } = await req('POST', '/v1/logs/executor', {
        token: SENTINEL_TOKEN,
        body: { check_type: 'e2e_sentinel_negative' },
      });
      // SENTINEL is not in @Identities allowlist for POST /v1/logs/executor
      expect(status).toBe(403);
    },
  );
});

// ---------------------------------------------------------------------------
// Verify enforce mode emits identity_blocked_enforce (not shadow) events
// ---------------------------------------------------------------------------

describe('Enforce-mode event naming', () => {
  it.skipIf(SKIP)(
    'blocked requests in enforce mode emit identity_blocked_enforce (not identity_blocked_shadow)',
    async () => {
      // Make a blocked request to ensure the enforce event is emitted
      await req('POST', '/v1/orders', {
        token: EXECUTOR_TOKEN,
        body: BUY_ORDER_BODY,
      });

      const enforceEvents = api.stderrLines.filter((line) => {
        try {
          const p = JSON.parse(line) as Record<string, unknown>;
          return p.event === 'identity_blocked_enforce';
        } catch {
          return false;
        }
      });

      const shadowEvents = api.stderrLines.filter((line) => {
        try {
          const p = JSON.parse(line) as Record<string, unknown>;
          return p.event === 'identity_blocked_shadow';
        } catch {
          return false;
        }
      });

      // Must emit the enforce-mode event name, never the shadow event name.
      expect(enforceEvents.length).toBeGreaterThan(0);
      expect(shadowEvents.length).toBe(0);
    },
  );
});
