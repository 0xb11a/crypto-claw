/**
 * Integration tests for `cclaw watchlist` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: list / get / add / update / remove
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7895
 * Note: cclaw-system-cash.spec.ts uses 7895. Assign 7896 here to avoid collision.
 * (The cash spec already reserves 7895 — reassigned to avoid conflict.)
 * Port: 7896
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

const PORT = 7896;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-watchlist-test',
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
    tmpPrefix: 'cclaw-watchlist-integration',
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

// Unique ID helper to avoid cross-test collision
function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

// ---------------------------------------------------------------------------
// watchlist list
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw watchlist list', () => {
  it('exits 0 and outputs a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'list']);
    expect(exitCode, `watchlist list failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('exits 0 with --active flag', () => {
    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'list', '--active']);
    expect(exitCode, `watchlist list --active failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('exits 0 with --status watching', () => {
    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'list', '--status', 'watching']);
    expect(exitCode, `watchlist list --status failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// watchlist add — happy path + audit
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw watchlist add', () => {
  it('exits 0 and returns the created entry', () => {
    const id = uid('wl');
    const body = JSON.stringify({
      id,
      symbol: 'TEST',
      address: '0xtest000000000000000000000000000000000001',
      chain: 'base',
    });
    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'add', '--json', body]);
    expect(exitCode, `watchlist add failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['symbol']).toBe('TEST');
    expect(parsed['chain']).toBe('base');
  });

  it('exits 1 for invalid JSON in --json flag', () => {
    const { exitCode, stderr } = cclaw(['watchlist', 'add', '--json', '{not valid json}']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[cclaw] Error');
  });

  it('exits 1 when --json is missing', () => {
    const { exitCode } = cclaw(['watchlist', 'add']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', () => {
    const id = uid('wl-dash');
    const body = JSON.stringify({
      id,
      symbol: 'FORBIDDEN',
      address: '0xtest000000000000000000000000000000000002',
      chain: 'base',
    });
    const { exitCode } = cclaw(['watchlist', 'add', '--json', body], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row (DoD §C)', async () => {
    const id = uid('wl-audit');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: {
        id,
        symbol: 'AUDIT',
        address: '0xtest000000000000000000000000000000000003',
        chain: 'base',
      },
    });
    const { status, body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/watchlist') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// watchlist get — by ID
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw watchlist get', () => {
  it('exits 0 and returns the entry shape when found', async () => {
    // Create a fresh entry via HTTP
    const id = uid('wl-get');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: { id, symbol: 'GETME', address: '0xabc000000000000000000000000000000000001', chain: 'solana' },
    });

    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'get', '--id', id]);
    expect(exitCode, `watchlist get failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['symbol']).toBe('GETME');
  });

  it('exits 1 for an unknown ID (404 from API)', () => {
    const { exitCode } = cclaw(['watchlist', 'get', '--id', 'does-not-exist-xyz-987']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['watchlist', 'get']);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// watchlist update
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw watchlist update', () => {
  it('exits 0 and reflects the updated field', async () => {
    const id = uid('wl-upd');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: { id, symbol: 'UPD', address: '0xupdtest000000000000000000000000000000001', chain: 'base' },
    });

    const updateBody = JSON.stringify({ current_price: 1.23 });
    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'update', '--id', id, '--json', updateBody]);
    expect(exitCode, `watchlist update failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['current_price']).toBe(1.23);
  });

  it('exits 1 for invalid JSON in --json flag', () => {
    const { exitCode, stderr } = cclaw(['watchlist', 'update', '--id', 'any', '--json', 'bad{json']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[cclaw] Error');
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['watchlist', 'update', '--json', '{}']);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row on update (DoD §C)', async () => {
    const id = uid('wl-upd-audit');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: { id, symbol: 'UPDAUDIT', address: '0xaudit00000000000000000000000000000000001', chain: 'base' },
    });
    await req('PATCH', `/v1/watchlist/${id}`, {
      token: AGENT_TOKEN,
      body: { current_price: 99 },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/watchlist') &&
        r['method'] === 'PATCH',
    );
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// watchlist remove (soft-delete)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw watchlist remove', () => {
  it('exits 0 and returns { ok: true }', async () => {
    const id = uid('wl-rm');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: { id, symbol: 'RM', address: '0xrm0000000000000000000000000000000000001', chain: 'base' },
    });

    const { exitCode, stdout, stderr } = cclaw(['watchlist', 'remove', '--id', id]);
    expect(exitCode, `watchlist remove failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['id']).toBe(id);
  });

  it('exits 1 for unknown ID (404)', () => {
    const { exitCode } = cclaw(['watchlist', 'remove', '--id', 'totally-unknown-000']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --id is missing', () => {
    const { exitCode } = cclaw(['watchlist', 'remove']);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row on remove (DoD §C)', async () => {
    const id = uid('wl-rm-audit');
    await req('POST', '/v1/watchlist', {
      token: AGENT_TOKEN,
      body: { id, symbol: 'RMAUDIT', address: '0xrmaudit00000000000000000000000000000001', chain: 'base' },
    });
    await req('DELETE', `/v1/watchlist/${id}`, { token: AGENT_TOKEN });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/watchlist') &&
        r['method'] === 'DELETE',
    );
    expect(found).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — auth assertions
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/watchlist — auth assertions', () => {
  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/watchlist');
    expect(status).toBe(401);
  });

  it('returns 200 for dashboard token (read)', async () => {
    const { status } = await req('GET', '/v1/watchlist', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 403 for dashboard token on POST', async () => {
    const { status } = await req('POST', '/v1/watchlist', {
      token: DASHBOARD_TOKEN,
      body: { id: 'forbidden', symbol: 'X', address: '0x1', chain: 'base' },
    });
    expect(status).toBe(403);
  });
});
