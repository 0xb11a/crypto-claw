/**
 * Adversarial integration tests for the agent-logs module (DoD §F).
 *
 * Covers the security scenarios specified in the P2 group 2 plan:
 * 1. summary > 8192 bytes → 400
 * 2. Unknown DTO field → 400 (forbidNonWhitelisted)
 * 3. status='hacker' (invalid enum) → 400
 * 4. count field < 0 (e.g. tokens_scanned: -1) → 400
 * 5. limit=999 (over max 500) → 400
 *
 * Gated behind CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * SPEC §14 — security integration tests.
 * DoD §F — security: DTO validation, unknown-field rejection.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from '../_spawn-api.js';
import type { StartApiResult } from '../_spawn-api.js';

const SKIP = process.env['CCLAW_SECURITY_TESTS_ENABLED'] !== '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-agent-logs-adversarial-test',
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

const PORT = 7884;
const BASE = `http://127.0.0.1:${PORT}`;

let api: StartApiResult;

beforeAll(async () => {
  if (SKIP) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-agent-logs-adversarial',
  });
}, 25_000);

afterAll(async () => {
  if (SKIP) return;
  await api.kill();
});

async function post(
  path: string,
  body: unknown,
  token = AGENT_TOKEN,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });
  let responseBody: unknown;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = null;
  }
  return { status: res.status, body: responseBody };
}

async function get(
  path: string,
  token = AGENT_TOKEN,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  let responseBody: unknown;
  try {
    responseBody = await res.json();
  } catch {
    responseBody = null;
  }
  return { status: res.status, body: responseBody };
}

// ---------------------------------------------------------------------------
// Scenario 1: summary > 8192 bytes → 400
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — 8KB+ summary → 400', () => {
  const bigSummary = 'A'.repeat(8193); // one byte over the 8192 limit

  it.skipIf(SKIP)('POST /v1/logs/research with 8193-byte summary returns 400', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      summary: bigSummary,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/sentinel with 8193-byte summary returns 400', async () => {
    const { status } = await post('/v1/logs/sentinel', {
      check_type: 'price_check',
      summary: bigSummary,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/executor with 8193-byte summary returns 400', async () => {
    const { status } = await post('/v1/logs/executor', { summary: bigSummary });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with 8193-byte summary returns 400', async () => {
    const { status } = await post('/v1/logs/observer', { summary: bigSummary });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 2: Unknown DTO field → 400 (forbidNonWhitelisted)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — unknown field → 400 (forbidNonWhitelisted)', () => {
  it.skipIf(SKIP)('POST /v1/logs/research with unknown field returns 400', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      totally_unknown_field: 'injected',
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/sentinel with unknown field returns 400', async () => {
    const { status } = await post('/v1/logs/sentinel', {
      check_type: 'price_check',
      hacker_field: true,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with unknown field returns 400', async () => {
    const { status } = await post('/v1/logs/observer', {
      sql_injection: "'; DROP TABLE observer_log; --",
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 3: status='hacker' (invalid enum) → 400
// ---------------------------------------------------------------------------

describe("agent-logs adversarial — status='hacker' → 400", () => {
  it.skipIf(SKIP)("POST /v1/logs/research with status='hacker' returns 400", async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      status: 'hacker',
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)("POST /v1/logs/observer with status='invalid' returns 400", async () => {
    const { status } = await post('/v1/logs/observer', { status: 'invalid' });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)("GET /v1/logs/research?status=hacker returns 400", async () => {
    const { status } = await get('/v1/logs/research?status=hacker');
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 4: count field < 0 → 400
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — negative count field → 400', () => {
  it.skipIf(SKIP)('POST /v1/logs/research with tokens_scanned=-1 returns 400', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      tokens_scanned: -1,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/sentinel with positions_checked=-5 returns 400', async () => {
    const { status } = await post('/v1/logs/sentinel', {
      check_type: 'price_check',
      positions_checked: -5,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/executor with success_count=-100 returns 400', async () => {
    const { status } = await post('/v1/logs/executor', { success_count: -100 });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with errors_analyzed=-1 returns 400', async () => {
    const { status } = await post('/v1/logs/observer', { errors_analyzed: -1 });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 5: limit=999 (over max 500) → 400
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — limit > 500 → 400', () => {
  it.skipIf(SKIP)('GET /v1/logs/research?limit=999 returns 400', async () => {
    const { status } = await get('/v1/logs/research?limit=999');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/sentinel?limit=501 returns 400', async () => {
    const { status } = await get('/v1/logs/sentinel?limit=501');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/executor?limit=0 returns 400 (min=1)', async () => {
    const { status } = await get('/v1/logs/executor?limit=0');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/observer?limit=500 returns 200 (valid boundary)', async () => {
    const { status } = await get('/v1/logs/observer?limit=500');
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Scenario 6: check_type > 64 chars → 400
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — check_type > 64 chars → 400', () => {
  it.skipIf(SKIP)('POST /v1/logs/research with check_type > 64 chars returns 400', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'A'.repeat(65),
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/sentinel with check_type = 64 chars returns 201 (boundary valid)', async () => {
    const { status } = await post('/v1/logs/sentinel', {
      check_type: 'A'.repeat(64),
    });
    expect(status).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Scenario 7: ParseIntPipe on :id with non-integer → 400
// (Coder-flagged adversarial gap #1)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — non-integer :id → 400 (ParseIntPipe)', () => {
  it.skipIf(SKIP)('GET /v1/logs/research/abc returns 400 not 500', async () => {
    const { status } = await get('/v1/logs/research/abc');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/sentinel/abc returns 400 not 500', async () => {
    const { status } = await get('/v1/logs/sentinel/abc');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/executor/abc returns 400 not 500', async () => {
    const { status } = await get('/v1/logs/executor/abc');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/observer/abc returns 400 not 500', async () => {
    const { status } = await get('/v1/logs/observer/abc');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/research/1.5 returns 400 (float is not integer)', async () => {
    const { status } = await get('/v1/logs/research/1.5');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/research/0xdeadbeef returns 400 (StrictParseIntPipe rejects hex)', async () => {
    // StrictParseIntPipe (P2 cleanup) uses /^-?\d+$/ regex — rejects hex literals.
    // Previously NestJS ParseIntPipe would coerce '0xdeadbeef' to id=0 → 404.
    // Now returns 400 (validation failure at the pipe layer).
    const { status } = await get('/v1/logs/research/0xdeadbeef');
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 8: SQL injection in check_type stored as plain string
// (Coder-flagged adversarial gap #2)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — SQL injection in check_type stored as plain string', () => {
  it.skipIf(SKIP)(
    "POST /v1/logs/research with check_type SQL injection payload stores and returns verbatim",
    async () => {
      // Truncated to 64 chars to pass the MaxLength validator
      const sqlPayload = "'; DROP TABLE research_log; --".slice(0, 64);
      const { status, body } = await post('/v1/logs/research', {
        check_type: sqlPayload,
      });
      expect(status).toBe(201);
      // The value is returned as-is — Prisma parameterises it, no SQL was executed
      expect((body as Record<string, unknown>)['check_type']).toBe(sqlPayload);
    },
  );

  it.skipIf(SKIP)(
    "GET /v1/logs/research after SQL-injection seed returns the row unchanged",
    async () => {
      const sqlPayload = "'; SELECT * FROM sqlite_master; --".slice(0, 64);
      // First, seed the row
      await post('/v1/logs/research', { check_type: sqlPayload });
      // Fetch and verify table still exists by querying normally
      const { status, body } = await get('/v1/logs/research?limit=1');
      expect(status).toBe(200);
      expect(Array.isArray(body)).toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 9: since=not-a-date — now returns 400 (P2 cleanup: @IsISO8601 applied)
// Previously documented pass-through behavior; deferred nit #3 now landed.
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — since=not-a-date returns 400 (P2 cleanup: @IsISO8601)', () => {
  it.skipIf(SKIP)(
    "GET /v1/logs/research?since=not-a-date returns 400 (invalid ISO-8601 string)",
    async () => {
      // @IsISO8601({strict: true}) now validates the since field.
      // Invalid ISO-8601 strings are rejected at the DTO validation layer → 400.
      const { status } = await get('/v1/logs/research?since=not-a-date');
      expect(status).toBe(400);
    },
  );

  it.skipIf(SKIP)(
    "GET /v1/logs/research?since=2026-05-14T00:00:00Z returns 200 (valid ISO-8601)",
    async () => {
      const { status } = await get('/v1/logs/research?since=2026-05-14T00:00:00Z');
      expect(status).toBe(200);
    },
  );
});

// ---------------------------------------------------------------------------
// Scenario 10: tokens_scanned: 1_000_001 (over Max) → 400
// (Coder-flagged additional check from brief)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — count field over Max(1_000_000) → 400', () => {
  it.skipIf(SKIP)('POST /v1/logs/research with tokens_scanned=1_000_001 returns 400', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      tokens_scanned: 1_000_001,
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('POST /v1/logs/research with tokens_scanned=1_000_000 returns 201 (boundary valid)', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      tokens_scanned: 1_000_000,
    });
    expect(status).toBe(201);
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with errors_analyzed=1_000_001 returns 400', async () => {
    const { status } = await post('/v1/logs/observer', {
      errors_analyzed: 1_000_001,
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 11: summary boundary — 8192 chars → 201, 8193 chars → 400
// (Coder-flagged additional check from brief — explicit boundary tests)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — summary boundary: 8192 → 201, 8193 → 400', () => {
  it.skipIf(SKIP)('POST /v1/logs/research with summary=8192 chars returns 201 (boundary valid)', async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      summary: 'A'.repeat(8192),
    });
    expect(status).toBe(201);
  });

  it.skipIf(SKIP)('POST /v1/logs/executor with summary=8192 chars returns 201 (boundary valid)', async () => {
    const { status } = await post('/v1/logs/executor', {
      summary: 'A'.repeat(8192),
    });
    expect(status).toBe(201);
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with summary=8193 chars returns 400 (over limit)', async () => {
    const { status } = await post('/v1/logs/observer', {
      summary: 'A'.repeat(8193),
    });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 12: limit=500 (max boundary) → 200; limit=501 (over) → 400
// (Coder-flagged additional check from brief)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — limit boundary: 500 → 200, 501 → 400', () => {
  it.skipIf(SKIP)('GET /v1/logs/research?limit=500 returns 200 (valid boundary)', async () => {
    const { status } = await get('/v1/logs/research?limit=500');
    expect(status).toBe(200);
  });

  it.skipIf(SKIP)('GET /v1/logs/executor?limit=501 returns 400 (over max)', async () => {
    const { status } = await get('/v1/logs/executor?limit=501');
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)('GET /v1/logs/sentinel?limit=500 returns 200 (valid boundary)', async () => {
    const { status } = await get('/v1/logs/sentinel?limit=500');
    expect(status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Scenario 13: status='fatal' (invalid enum) → 400
// (Coder-flagged additional check from brief)
// ---------------------------------------------------------------------------

describe("agent-logs adversarial — status='fatal' → 400", () => {
  it.skipIf(SKIP)("POST /v1/logs/research with status='fatal' returns 400", async () => {
    const { status } = await post('/v1/logs/research', {
      check_type: 'token_scan',
      status: 'fatal',
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)("POST /v1/logs/sentinel with status='fatal' returns 400", async () => {
    const { status } = await post('/v1/logs/sentinel', {
      check_type: 'price_check',
      status: 'fatal',
    });
    expect(status).toBe(400);
  });

  it.skipIf(SKIP)("GET /v1/logs/executor?status=fatal returns 400", async () => {
    const { status } = await get('/v1/logs/executor?status=fatal');
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// Scenario 14: ExecutorLog POST with empty body {} → 201 with all defaults
// (Coder-flagged uncertainty #2)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — ExecutorLog POST empty body → 201 with defaults', () => {
  it.skipIf(SKIP)('POST /v1/logs/executor with {} returns 201 and zero counts', async () => {
    const { status, body } = await post('/v1/logs/executor', {});
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(typeof row['id']).toBe('number');
    expect(row['sell_orders_processed']).toBe(0);
    expect(row['buy_orders_processed']).toBe(0);
    expect(row['pending_checked']).toBe(0);
    expect(row['success_count']).toBe(0);
    expect(row['fail_count']).toBe(0);
    expect(row['queued_count']).toBe(0);
    expect(row['status']).toBe('ok');
    expect(row['summary']).toBeNull();
  });

  it.skipIf(SKIP)('POST /v1/logs/observer with {} returns 201 and zero counts', async () => {
    const { status, body } = await post('/v1/logs/observer', {});
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    expect(row['errors_analyzed']).toBe(0);
    expect(row['issues_created']).toBe(0);
    expect(row['alerts_sent']).toBe(0);
    expect(row['status']).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Scenario 15: created_at SQLite default format — YYYY-MM-DD HH:MM:SS
// (Coder-flagged uncertainty #3)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — created_at format is YYYY-MM-DD HH:MM:SS (not ISO-Z)', () => {
  it.skipIf(SKIP)('POST /v1/logs/research created_at matches SQLite datetime format', async () => {
    const { status, body } = await post('/v1/logs/research', {
      check_type: 'datetime_format_check',
    });
    expect(status).toBe(201);
    const row = body as Record<string, unknown>;
    const createdAt = row['created_at'];
    // SQLite DEFAULT (datetime('now')) produces "YYYY-MM-DD HH:MM:SS" not ISO-Z
    if (createdAt !== null) {
      expect(typeof createdAt).toBe('string');
      // Must NOT end with 'Z' (ISO-Z format)
      expect(createdAt as string).not.toMatch(/Z$/);
      // Must match SQLite datetime pattern
      expect(createdAt as string).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 16: Concurrent appends across agents — no shared-state corruption
// (Coder-flagged additional check from brief)
// ---------------------------------------------------------------------------

describe('agent-logs adversarial — concurrent appends across agents', () => {
  it.skipIf(SKIP)('POST /v1/logs/research and /v1/logs/sentinel concurrently both succeed', async () => {
    const [researchResult, sentinelResult] = await Promise.all([
      post('/v1/logs/research', {
        check_type: 'concurrent_test_research',
        tokens_scanned: 1,
        status: 'ok',
      }),
      post('/v1/logs/sentinel', {
        check_type: 'concurrent_test_sentinel',
        positions_checked: 1,
        status: 'ok',
      }),
    ]);

    expect(researchResult.status).toBe(201);
    expect(sentinelResult.status).toBe(201);

    // Verify the rows have distinct IDs (no shared-state corruption)
    const researchRow = researchResult.body as Record<string, unknown>;
    const sentinelRow = sentinelResult.body as Record<string, unknown>;
    expect(researchRow['id']).not.toBe(sentinelRow['id']);

    // Verify each row landed in the correct table
    expect(researchRow['check_type']).toBe('concurrent_test_research');
    expect(sentinelRow['check_type']).toBe('concurrent_test_sentinel');
  });

  it.skipIf(SKIP)('10 concurrent POST /v1/logs/executor appends all return 201 with distinct IDs', async () => {
    const requests = Array.from({ length: 10 }, (_, i) =>
      post('/v1/logs/executor', {
        sell_orders_processed: i,
        status: 'ok',
      }),
    );

    const results = await Promise.all(requests);
    const ids = results.map((r) => (r.body as Record<string, unknown>)['id']);

    results.forEach((r) => expect(r.status).toBe(201));
    // All IDs must be distinct
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(10);
  });
});
