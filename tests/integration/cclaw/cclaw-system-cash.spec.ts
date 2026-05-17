/**
 * Integration tests for `cclaw system cash` and `cclaw system gas` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * ==========================================================================
 * BUG REPORT — sdk/cclaw/src/index.ts line 550:
 *
 * `cclaw system cash set` sends { chain, cash: amount } to PATCH /v1/system/cash
 * but SetCashDto expects { chain, amount } (field name is "amount", not "cash").
 *
 * Source of truth:
 *   libs/modules/system/src/dto/set-cash.dto.ts — `amount!: number;`
 *
 * The broken line:
 *   const data = await apiCall<unknown>('PATCH', '/system/cash', { chain: opts.chain, cash: amount });
 *
 * Required fix (coder must apply):
 *   const data = await apiCall<unknown>('PATCH', '/system/cash', { chain: opts.chain, amount });
 *
 * Effect: `cclaw system cash set --chain base --amount 1000` currently returns
 * 400 Bad Request because the body fails SetCashDto validation (missing `amount`
 * field, unknown `cash` field stripped by class-transformer whitelist).
 *
 * The test `cclaw system cash set — exits 0 and sets cash [BUG: sends cash field not amount]`
 * is the DoD §A regression gate.  It FAILS until the fix lands.
 * ==========================================================================
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

const PORT = 7895;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-cash-test',
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
    tmpPrefix: 'cclaw-cash-cli-integration',
  });
}, 25_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
});

/** cclaw CLI env for this test suite. */
const cclawEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  CCLAW_API_BASE: BASE,
  CCLAW_API_TOKEN: AGENT_TOKEN,
});

/** Run cclaw binary synchronously; return { exitCode, stdout, stderr }. */
function cclaw(args: string[]): { exitCode: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync('node', [CCLAW_BIN, ...args], {
      encoding: 'utf8',
      env: cclawEnv(),
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
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// cclaw system cash get — no chain (all chains)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system cash get — all chains', () => {
  it('exits 0 and outputs JSON with a total field', () => {
    const { exitCode, stdout } = cclaw(['system', 'cash', 'get']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(typeof parsed['total']).toBe('number');
  });

  it('output is valid JSON (not empty string)', () => {
    const { stdout } = cclaw(['system', 'cash', 'get']);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cclaw system cash get --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system cash get --chain base', () => {
  it('exits 0 and returns { chain, cash } shape', () => {
    const { exitCode, stdout } = cclaw(['system', 'cash', 'get', '--chain', 'base']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['chain']).toBe('base');
    expect(typeof parsed['cash']).toBe('number');
  });

  it('exits 1 with API error for unknown chain that has no record (still 200 not 404)', () => {
    // Any chain is valid as a string — the API returns zero defaults, not 404.
    // This test ensures the flag is passed correctly and the API responds.
    const { exitCode, stdout } = cclaw(['system', 'cash', 'get', '--chain', 'eth']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['chain']).toBe('eth');
  });
});

// ---------------------------------------------------------------------------
// cclaw system cash set — BUG REGRESSION GATE
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system cash set — exits 0 and sets cash [BUG: sends cash field not amount]', () => {
  /**
   * This test FAILS until the coder fixes sdk/cclaw/src/index.ts line 550.
   *
   * Current behavior:
   *   cclaw sends: { chain: 'base', cash: 1000 }
   *   SetCashDto expects: { chain: 'base', amount: 1000 }
   *   API returns 400 Bad Request.
   *
   * After fix:
   *   cclaw sends: { chain: 'base', amount: 1000 }
   *   API returns 200 { ok: true, chain: 'base', cash: 1000 }
   *   exitCode === 0
   */
  it('exits 0 when setting cash for a chain', () => {
    const { exitCode, stderr } = cclaw(['system', 'cash', 'set', '--chain', 'base', '--amount', '1000']);
    // This assertion FAILS until the bug is fixed.
    expect(exitCode, `cclaw system cash set failed: ${stderr}`).toBe(0);
  });

  it('exits 1 for negative amount (client-side guard)', () => {
    const { exitCode, stderr } = cclaw(['system', 'cash', 'set', '--chain', 'base', '--amount', '-5']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--amount must be a non-negative number');
  });

  it('exits 1 for non-numeric amount (client-side guard)', () => {
    const { exitCode, stderr } = cclaw(['system', 'cash', 'set', '--chain', 'base', '--amount', 'notanumber']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--amount must be a non-negative number');
  });

  it('exits 1 when --chain is missing (Commander missing required option)', () => {
    const { exitCode } = cclaw(['system', 'cash', 'set', '--amount', '100']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --amount is missing (Commander missing required option)', () => {
    const { exitCode } = cclaw(['system', 'cash', 'set', '--chain', 'base']);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — set cash (bypasses the CLI bug; verifies API works correctly)
// This test documents the correct API contract so the fix can be verified.
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('PATCH /v1/system/cash — direct HTTP (API contract, not CLI)', () => {
  it('returns 200 when body uses { chain, amount } (correct DTO shape)', async () => {
    const { status, body } = await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'base', amount: 999.5 },
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['ok']).toBe(true);
    expect((body as Record<string, unknown>)['cash']).toBe(999.5);
  });

  it('returns 400 when body uses { chain, cash } (wrong field — same as the CLI bug)', async () => {
    const { status } = await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'base', cash: 999.5 },
    });
    // The CLI bug sends this shape. The API correctly rejects it with 400.
    expect(status).toBe(400);
  });

  it('returns 403 for dashboard token', async () => {
    const { status } = await req('PATCH', '/v1/system/cash', {
      token: DASHBOARD_TOKEN,
      body: { chain: 'base', amount: 100 },
    });
    expect(status).toBe(403);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('PATCH', '/v1/system/cash', {
      body: { chain: 'base', amount: 100 },
    });
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// cclaw system gas --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system gas --chain base', () => {
  it('exits 0 and returns gas response shape', () => {
    const { exitCode, stdout } = cclaw(['system', 'gas', '--chain', 'base']);
    expect(exitCode).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['chain']).toBe('base');
    expect(typeof parsed['balance']).toBe('number');
    expect(typeof parsed['value_usd']).toBe('number');
  });

  it('exits 1 when --chain is missing', () => {
    const { exitCode } = cclaw(['system', 'gas']);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Audit row for PATCH /v1/system/cash (DoD §C)
// (Tested via HTTP because CLI bug prevents triggering the write path via cclaw)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('PATCH /v1/system/cash — audit row (DoD §C)', () => {
  it('writes an audit row when cash is set via HTTP', async () => {
    await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'solana', amount: 777 },
    });
    const { status, body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/system/cash') &&
        r['method'] === 'PATCH',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(200);
  });
});
