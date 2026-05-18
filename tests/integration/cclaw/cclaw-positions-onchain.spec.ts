/**
 * Integration tests for `cclaw positions set-onchain-balance` subcommand.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: positions set-onchain-balance --id --balance
 *
 * BODY FIELD VERIFICATION:
 *   CLI sends { onchain_balance: N } to PATCH /v1/positions/:id.
 *   UpdatePositionDto field: `onchain_balance?: number` @IsNumber() @Min(0)
 *   Source: libs/modules/positions/src/dto/update-position.dto.ts
 *   CLI source (index.ts ~line 159): `{ onchain_balance: balance }`
 *
 * ADVERSARIAL ASSERTIONS:
 *   --balance -1    → exit 1 (client-side guard: must be non-negative)
 *   --balance notanumber → exit 1 (client-side guard: must be numeric)
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7903
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

const PORT = 7903;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-positions-onchain-test',
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
    tmpPrefix: 'cclaw-positions-onchain-integration',
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

/** Create a minimal real position and return its ID. */
async function createPosition(): Promise<string> {
  const { body } = await req('POST', '/v1/positions', {
    token: AGENT_TOKEN,
    body: {
      symbol: 'ONCHAIN',
      address: '0x' + 'f'.repeat(40),
      chain: 'base',
      tier: 'base',
      entry_price: 1.0,
      quantity: 100,
      stop_loss: 0.5,
      take_profit_levels: [2.0],
    },
  });
  return (body as Record<string, unknown>)['id'] as string;
}

// ---------------------------------------------------------------------------
// positions set-onchain-balance — happy path
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw positions set-onchain-balance — happy path', () => {
  it('exits 0 and reflects the updated onchain_balance', async () => {
    const id = await createPosition();
    const { exitCode, stdout, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', id,
      '--balance', '99.5',
    ]);
    expect(exitCode, `set-onchain-balance failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['onchain_balance']).toBe(99.5);
  });

  it('exits 0 with zero balance (boundary: @Min(0) allows 0)', async () => {
    const id = await createPosition();
    const { exitCode, stdout, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', id,
      '--balance', '0',
    ]);
    expect(exitCode, `set-onchain-balance --balance 0 failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['onchain_balance']).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// positions set-onchain-balance — adversarial cases
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw positions set-onchain-balance — adversarial', () => {
  it('exits 1 for --balance -1 (client-side non-negative guard)', () => {
    const { exitCode, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', 'any-id',
      '--balance', '-1',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--balance must be a non-negative number');
  });

  it('exits 1 for --balance notanumber (client-side guard)', () => {
    const { exitCode, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', 'any-id',
      '--balance', 'notanumber',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--balance must be a non-negative number');
  });

  it('exits 1 for --balance NaN (client-side guard)', () => {
    const { exitCode, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', 'any-id',
      '--balance', 'NaN',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--balance must be a non-negative number');
  });

  it('exits 1 for --balance Infinity (client-side guard: isFinite check)', () => {
    const { exitCode, stderr } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', 'any-id',
      '--balance', 'Infinity',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--balance must be a non-negative number');
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['positions', 'set-onchain-balance', '--balance', '10']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --balance is missing', () => {
    const { exitCode } = cclaw(['positions', 'set-onchain-balance', '--id', 'any-id']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for unknown position ID (404)', () => {
    const { exitCode } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', 'does-not-exist-xyz-999',
      '--balance', '10',
    ]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', async () => {
    const id = await createPosition();
    const { exitCode } = cclaw([
      'positions', 'set-onchain-balance',
      '--id', id,
      '--balance', '10',
    ], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Body field verification: CLI sends onchain_balance (not balance)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('PATCH /v1/positions/:id — body field name verification', () => {
  it('returns 200 when body uses onchain_balance (correct DTO field)', async () => {
    const id = await createPosition();
    const { status, body } = await req('PATCH', `/v1/positions/${id}`, {
      token: AGENT_TOKEN,
      body: { onchain_balance: 42.5 },
    });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['onchain_balance']).toBe(42.5);
  });

  it('returns 200 even when balance field is sent (extra unknown field, stripped by whitelist)', async () => {
    // The class-transformer whitelist strips unknown fields silently.
    // Sending { balance: 99 } would be stripped, resulting in no update to onchain_balance.
    // This test documents the contract: only onchain_balance is recognized.
    const id = await createPosition();
    const before = await req('GET', `/v1/positions/${id}`, { token: AGENT_TOKEN });
    const beforeBalance = (before.body as Record<string, unknown>)['onchain_balance'];

    await req('PATCH', `/v1/positions/${id}`, {
      token: AGENT_TOKEN,
      body: { balance: 9999 }, // wrong field name — stripped by whitelist
    });

    const after = await req('GET', `/v1/positions/${id}`, { token: AGENT_TOKEN });
    // onchain_balance should remain unchanged (balance field was ignored)
    expect((after.body as Record<string, unknown>)['onchain_balance']).toBe(beforeBalance);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('PATCH', '/v1/positions/any-id', {
      body: { onchain_balance: 10 },
    });
    expect(status).toBe(401);
  });

  it('returns 403 for dashboard token', async () => {
    const id = await createPosition();
    const { status } = await req('PATCH', `/v1/positions/${id}`, {
      token: DASHBOARD_TOKEN,
      body: { onchain_balance: 10 },
    });
    expect(status).toBe(403);
  });
});

// ---------------------------------------------------------------------------
// Audit row (DoD §C)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('PATCH /v1/positions/:id — audit row (DoD §C)', () => {
  it('writes an audit row when onchain_balance is updated', async () => {
    const id = await createPosition();
    await req('PATCH', `/v1/positions/${id}`, {
      token: AGENT_TOKEN,
      body: { onchain_balance: 77 },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/positions/') &&
        r['method'] === 'PATCH',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(200);
  });
});
