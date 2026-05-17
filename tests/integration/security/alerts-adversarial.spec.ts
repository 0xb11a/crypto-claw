/**
 * Adversarial + lifecycle integration tests for POST /v1/alerts/send (DoD §F, §C).
 *
 * Covers (per P5c plan §D items 12-13 and uncertainty checks a-e):
 *
 *   Lifecycle (task 4):
 *   - POST returns 202 with { accepted: true }
 *   - Audit row written with method=POST, path=/v1/alerts/send, agent identity
 *   - data field NOT forwarded to NotificationsService (fire-and-forget only receives type/agent/message)
 *   - Route ordering: /send is matched as a literal, NOT as /:id
 *
 *   Auth enforcement (uncertainty a + task 3):
 *   - 401 without bearer token
 *   - 401 with unknown token
 *   - 403 with dashboard role (agent-only)
 *
 *   DTO validation (task 3):
 *   - 400 on invalid type (not in TOPIC_MAP)
 *   - 400 on missing message field
 *   - 400 on missing agent field
 *   - 400 on missing type field
 *   - 400 on message > 4000 chars
 *   - 400 on agent > 64 chars
 *   - 400 on agent empty string
 *
 *   Adversarial security (task 10):
 *   - message containing a Telegram-bot-token-shaped string → audit row body has [REDACTED_*]
 *   - type injection (SQL payload) → 400 from @IsIn() validation
 *   - data containing SAFE_SIGNER_KEY-like value → still returns 202 (service does not crash);
 *     security: the data field is NOT forwarded to Telegram (verified via service.send() unit test;
 *     confirmed here by asserting 202 does not 5xx on forbidden-looking content)
 *
 *   Uncertainty (d): LOOP_API_KEY has 'agent' role → 202 accepted
 *   Uncertainty (e): --since flag in cclaw system audit accepts only ISO timestamps
 *
 * All tests spawn the compiled API binary. Gated by CCLAW_SECURITY_TESTS_ENABLED=1.
 *
 * Port: 7893 — unique, avoids collision with other integration spec files.
 *
 * SPEC §14 — security tests.
 * DoD §A — tests that fail before / pass after.
 * DoD §F — security: auth, validation, redaction.
 * ADR-0028 — notifications via cclaw alerts send.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const PORT = 7893;
const BASE = `http://127.0.0.1:${PORT}`;

// Tokens — match the CI env block used by other integration tests
const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const LOOP_TOKEN = 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';
const UNKNOWN_TOKEN = 'completely-unknown-token-xyz-12345';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-alerts-send-test',
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
  // Telegram vars intentionally absent — tests verify fire-and-forget (silent drop on absent config)
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

let api: StartApiResult;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function request(
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

// Valid minimal SendAlertDto
const VALID_BODY = {
  type: 'rug_warning',
  agent: 'sentinel',
  message: 'rug detected on TOKEN/base',
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-alerts-send',
  });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

// ---------------------------------------------------------------------------
// 1. Route ordering — POST /v1/alerts/send is NOT mismatched as /:id
// (Uncertainty a — ADR-0028 comment: "declared BEFORE /:id")
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — route ordering (not matched as /:id)', () => {
  it('POST /v1/alerts/send returns 202 not 404 (literal segment wins over :id param)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });
    // If route ordering is wrong, NestJS would match "send" as an :id and return 404/400
    expect(status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// 2. Auth enforcement (SPEC §9.1–§9.3, DoD §F)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — auth enforcement', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const { status } = await request('POST', '/v1/alerts/send', { body: VALID_BODY });
    expect(status).toBe(401);
  });

  it('returns 401 for an unknown bearer token', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: UNKNOWN_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(401);
  });

  it('returns 403 for dashboard role (agent-only route, ADR-0028)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: DASHBOARD_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(403);
  });

  it('returns 202 for agent role (research token)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(202);
  });

  it('returns 202 for LOOP_API_KEY role=agent (uncertainty d — entrypoint.sh uses LOOP token)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: LOOP_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path: response shape + audit row (DoD §C)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — response shape + audit row (DoD §C, SPEC §9.5)', () => {
  it('returns 202 with { accepted: true } in body', async () => {
    const { status, body } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });
    expect(status).toBe(202);
    expect((body as { accepted: boolean }).accepted).toBe(true);
  });

  it('body only contains accepted=true (not extra fields)', async () => {
    const { body } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });
    const keys = Object.keys(body as object);
    expect(keys).toEqual(['accepted']);
  });

  it('writes an audit row with method=POST and path=/v1/alerts/send', async () => {
    await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });

    // Query audit log
    const { body: auditBody } = await request('GET', '/v1/system/audit?limit=50', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<{ path: string; method: string; identity: string; status: number }> }).data;
    const sendRow = rows.find((r) => r.path === '/v1/alerts/send' && r.method === 'POST');

    expect(sendRow).toBeDefined();
    expect(sendRow?.status).toBe(202);
  });

  it('audit row identity is RESEARCH (from agent token used)', async () => {
    await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: VALID_BODY,
    });

    const { body: auditBody } = await request('GET', '/v1/system/audit?limit=50', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<{ path: string; method: string; identity: string }> }).data;
    const sendRow = rows.find((r) => r.path === '/v1/alerts/send' && r.method === 'POST');

    expect(sendRow?.identity).toBe('RESEARCH');
  });

  it('audit row identity is LOOP when LOOP_API_KEY is used (uncertainty d)', async () => {
    await request('POST', '/v1/alerts/send', {
      token: LOOP_TOKEN,
      body: { type: 'recovered', agent: 'executor', message: 'loop identity test' },
    });

    const { body: auditBody } = await request('GET', '/v1/system/audit?limit=20', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<{ path: string; method: string; identity: string; body?: unknown }> }).data;
    const sendRow = rows.find(
      (r) =>
        r.path === '/v1/alerts/send' &&
        r.method === 'POST' &&
        r.identity === 'LOOP',
    );

    expect(sendRow).toBeDefined();
    expect(sendRow?.identity).toBe('LOOP');
  });

  it('data field is present in the audit row body (stored for audit)', async () => {
    const dtoWithData = {
      type: 'system_health',
      agent: 'observer',
      message: 'data field audit test',
      data: { cycle: 42, source: 'test' },
    };

    await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: dtoWithData,
    });

    const { body: auditBody } = await request('GET', '/v1/system/audit?limit=20', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<{ path: string; method: string; body_redacted?: unknown }> }).data;
    const sendRow = rows.find(
      (r) =>
        r.path === '/v1/alerts/send' &&
        r.method === 'POST' &&
        typeof r.body_redacted === 'string' &&
        (r.body_redacted as string).includes('data field audit test'),
    );

    // The audit row body should contain the request body including data
    expect(sendRow).toBeDefined();
    expect(sendRow?.body_redacted).toBeDefined();
    const parsedBody = JSON.parse(sendRow!.body_redacted as string) as Record<string, unknown>;
    expect(parsedBody['data']).toEqual({ cycle: 42, source: 'test' });
  });

  it('202 response does NOT include data field (response shape is only { accepted: true })', async () => {
    const { body } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'system_health',
        agent: 'observer',
        message: 'response shape check',
        data: { should_not_appear: true },
      },
    });

    expect((body as Record<string, unknown>)['data']).toBeUndefined();
    expect((body as Record<string, unknown>)['accepted']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. DTO validation — 400 on invalid inputs (SPEC §9.3, DoD §F)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — DTO validation (400)', () => {
  it('returns 400 when type is not a valid AlertType', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'invalid_type_not_in_topic_map', agent: 'sentinel', message: 'test' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when type is missing', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { agent: 'sentinel', message: 'test' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when agent is missing', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', message: 'test' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when message is missing', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'sentinel' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when message exceeds 4000 characters (Telegram cap)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'sentinel', message: 'A'.repeat(4001) },
    });
    expect(status).toBe(400);
  });

  it('returns 202 when message is exactly 4000 characters (boundary valid)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'sentinel', message: 'A'.repeat(4000) },
    });
    expect(status).toBe(202);
  });

  it('returns 400 when agent exceeds 64 characters', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'A'.repeat(65), message: 'test' },
    });
    expect(status).toBe(400);
  });

  it('returns 202 when agent is exactly 64 characters (boundary valid)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'A'.repeat(64), message: 'test' },
    });
    expect(status).toBe(202);
  });

  it('returns 400 when agent is empty string', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: '', message: 'test' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when an unknown DTO field is included (forbidNonWhitelisted)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'sentinel', message: 'test', injected: 'extra' },
    });
    expect(status).toBe(400);
  });

  it('returns 400 when body is empty {}', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {},
    });
    expect(status).toBe(400);
  });

  it('returns 202 with optional data field (data field is @IsOptional)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'model_failure', agent: 'executor', message: 'test', data: { extra: true } },
    });
    expect(status).toBe(202);
  });

  it('returns 202 without data field (data field optional)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'model_failure', agent: 'executor', message: 'no data field' },
    });
    expect(status).toBe(202);
  });
});

// ---------------------------------------------------------------------------
// 5. AlertType enumeration — all 15 valid types accepted
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — all 15 AlertType literals accepted (202)', () => {
  const ALERT_TYPES = [
    'recovered',
    'trade_proposal',
    'trade_executed',
    'trade_failed',
    'trade_retry',
    'sell_triggered',
    'sentinel_alert_followup',
    'model_failure',
    'emergency_mode',
    'rug_warning',
    'signer_low_balance',
    'system_health',
    'heartbeat_summary',
    'portfolio_daily',
    'rebalance_event',
  ] as const;

  for (const type of ALERT_TYPES) {
    it(`type="${type}" → 202 accepted`, async () => {
      const { status } = await request('POST', '/v1/alerts/send', {
        token: AGENT_TOKEN,
        body: { type, agent: 'test', message: `test alert for ${type}` },
      });
      expect(status).toBe(202);
    });
  }
});

// ---------------------------------------------------------------------------
// 6. Adversarial security (task 10, DoD §F)
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('POST /v1/alerts/send — adversarial security (DoD §F)', () => {
  // (a) Bot-token-shaped string in message body
  // pre-commit-allow: test fixture — not a real Telegram bot token
  const FAKE_BOT_TOKEN_MESSAGE =
    '1234567890:AAEhBP0av28kxbMnJoY-fake-secret-aaaaaaaa-bbbbbbb'; // pre-commit-allow

  it('message containing bot-token-shaped string still returns 202 (validation passes string content)', async () => {
    // The redaction check happens at the logger layer; HTTP response is still 202.
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'system_health',
        agent: 'observer',
        message: `alert with token in body: ${FAKE_BOT_TOKEN_MESSAGE}`,
      },
    });
    expect(status).toBe(202);
  });

  it('audit row for bot-token-containing message should have redacted body (DoD §F — logger redaction)', async () => {
    await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'system_health',
        agent: 'observer',
        message: `token-redaction-test: ${FAKE_BOT_TOKEN_MESSAGE}`,
      },
    });

    const { body: auditBody } = await request('GET', '/v1/system/audit?limit=30', {
      token: AGENT_TOKEN,
    });
    const rows = (auditBody as { data: Array<{ path: string; method: string; body_redacted?: unknown }> }).data;
    const sendRow = rows.find(
      (r) =>
        r.path === '/v1/alerts/send' &&
        r.method === 'POST' &&
        typeof r.body_redacted === 'string' &&
        (r.body_redacted as string).includes('token-redaction-test'),
    );

    // Assertion runs unconditionally — DoD §F requires verifiable proof,
    // not pass-by-undefined. AuditInterceptor must have written this row.
    expect(sendRow).toBeDefined();
    expect(sendRow?.body_redacted).toBeDefined();
    // The audit row body must NOT contain the raw bot token. RE_TELEGRAM_BOT_TOKEN
    // in libs/logger/src/redactor.ts replaces bot-token-shaped strings before
    // body_redacted is persisted.
    expect(sendRow!.body_redacted as string).not.toContain(FAKE_BOT_TOKEN_MESSAGE);
  });

  // (b) SQL injection in type → 400 from @IsIn() validation
  it("type='\\'; DROP TABLE alerts; --' → 400 from @IsIn() validation", async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: "'; DROP TABLE alerts; --",
        agent: 'sentinel',
        message: 'injection attempt',
      },
    });
    expect(status).toBe(400);
  });

  // (c) data containing a SAFE_SIGNER_KEY-like value → 202 (data is not forwarded to Telegram)
  it('data containing SAFE_SIGNER_KEY-like value → 202 (data is audit-only, not forwarded to Telegram)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'system_health',
        agent: 'observer',
        message: 'signer-key-in-data test',
        // Fake key value — not a real signer key
        data: { SAFE_SIGNER_KEY: '0xfake0000000000000000000000000000000000000000000000000000000000000001' },
      },
    });
    // Service must not crash on data content; it does not forward data to NotificationsService
    expect(status).toBe(202);
  });

  // (d) XSS attempt in message → sanitized / accepted but not executed
  it('XSS in message → 202 (message is HTML-escaped by Telegram; service does not validate content)', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'model_failure',
        agent: 'executor',
        message: '<script>alert("xss")</script> executor crashed',
      },
    });
    expect(status).toBe(202);
  });

  // (e) Oversized type value (over 64 chars — not in TOPIC_MAP anyway → 400)
  it('type with 200-char string not in TOPIC_MAP → 400', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: {
        type: 'A'.repeat(200),
        agent: 'sentinel',
        message: 'oversized type',
      },
    });
    expect(status).toBe(400);
  });

  // (f) Array in message field (wrong type) → 400
  it('message as array instead of string → 400', async () => {
    const { status } = await request('POST', '/v1/alerts/send', {
      token: AGENT_TOKEN,
      body: { type: 'rug_warning', agent: 'sentinel', message: ['should', 'be', 'string'] },
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 7. Uncertainty (e): cclaw system audit --since requires ISO timestamp, not relative
// This documents the known behavior — observer HEARTBEAT.md uses "--since 5m"
// which does NOT work (the endpoint requires ISO-8601). This is a CONCERN.
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)('GET /v1/system/audit --since flag behavior (uncertainty e)', () => {
  it('since=5m (relative shortcut) returns 400 — ISO timestamp required', async () => {
    // Observer HEARTBEAT.md line 61 uses: cclaw system audit --path /v1/alerts/send --since 5m
    // This test DOCUMENTS that "5m" is NOT a valid ISO timestamp.
    // The coder must update observer prose to compute the ISO timestamp.
    const { status } = await request('GET', '/v1/system/audit?since=5m', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });

  it('since=2026-05-17T00:00:00Z (valid ISO-8601) returns 200', async () => {
    const { status } = await request('GET', '/v1/system/audit?since=2026-05-17T00:00:00Z', {
      token: AGENT_TOKEN,
    });
    expect(status).toBe(200);
  });
});
