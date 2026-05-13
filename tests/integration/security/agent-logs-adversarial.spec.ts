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
