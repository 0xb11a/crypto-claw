/**
 * Integration tests for `cclaw analysis` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: analysis list / check / cache / clear-expired
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7899
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

const PORT = 7899;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-analysis-test',
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
    tmpPrefix: 'cclaw-analysis-integration',
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

const TEST_ADDRESS = '0xanalysis000000000000000000000000deadbeef';
const TEST_CHAIN = 'base';
const CACHE_BODY = JSON.stringify({
  address: TEST_ADDRESS,
  chain: TEST_CHAIN,
  symbol: 'TEST',
  verdict: 'buy',
  ttl_hours: 24,
});

// ---------------------------------------------------------------------------
// analysis list
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw analysis list', () => {
  it('exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['analysis', 'list']);
    expect(exitCode, `analysis list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('exits 0 with --limit flag', () => {
    const { exitCode, stdout, stderr } = cclaw(['analysis', 'list', '--limit', '10']);
    expect(exitCode, `analysis list --limit failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// analysis cache (upsert)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw analysis cache', () => {
  it('exits 0 and returns the upserted entry', () => {
    const { exitCode, stdout, stderr } = cclaw(['analysis', 'cache', '--json', CACHE_BODY]);
    expect(exitCode, `analysis cache failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['address']).toBe(TEST_ADDRESS);
    expect(parsed['chain']).toBe(TEST_CHAIN);
    expect(parsed['verdict']).toBe('buy');
  });

  it('is idempotent — upsert same entry twice returns the entry both times', () => {
    const { exitCode: e1, stdout: s1 } = cclaw(['analysis', 'cache', '--json', CACHE_BODY]);
    const { exitCode: e2, stdout: s2 } = cclaw(['analysis', 'cache', '--json', CACHE_BODY]);
    expect(e1).toBe(0);
    expect(e2).toBe(0);
    // Both calls return the same address
    expect((JSON.parse(s1) as Record<string, unknown>)['address']).toBe(TEST_ADDRESS);
    expect((JSON.parse(s2) as Record<string, unknown>)['address']).toBe(TEST_ADDRESS);
  });

  it('exits 1 for invalid JSON in --json flag', () => {
    const { exitCode, stderr } = cclaw(['analysis', 'cache', '--json', '{bad}']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[cclaw] Error');
  });

  it('exits 1 when --json is missing', () => {
    const { exitCode } = cclaw(['analysis', 'cache']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', () => {
    const { exitCode } = cclaw(['analysis', 'cache', '--json', CACHE_BODY], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row (DoD §C)', async () => {
    await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, verdict: 'hold' },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/analysis-cache') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// analysis check — populated case
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw analysis check — populated case', () => {
  it('exits 0 when entry exists and returns address+chain', async () => {
    // Seed the cache via HTTP first
    await req('POST', '/v1/analysis-cache', {
      token: AGENT_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, verdict: 'buy', ttl_hours: 24 },
    });

    const { exitCode, stdout, stderr } = cclaw([
      'analysis', 'check',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
    ]);
    expect(exitCode, `analysis check failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['address']).toBe(TEST_ADDRESS);
    expect(parsed['chain']).toBe(TEST_CHAIN);
  });
});

// ---------------------------------------------------------------------------
// analysis check — empty case (404 from API)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw analysis check — empty case (no entry)', () => {
  it('exits 1 when no entry exists (404 from API)', () => {
    const unknownAddr = '0xdead000000000000000000000000000000000001';
    const { exitCode } = cclaw([
      'analysis', 'check',
      '--address', unknownAddr,
      '--chain', 'solana',
    ]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --address is missing', () => {
    const { exitCode } = cclaw(['analysis', 'check', '--chain', TEST_CHAIN]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --chain is missing', () => {
    const { exitCode } = cclaw(['analysis', 'check', '--address', TEST_ADDRESS]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// analysis clear-expired
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw analysis clear-expired', () => {
  it('exits 0 and returns { ok: true, deleted: N }', () => {
    const { exitCode, stdout, stderr } = cclaw(['analysis', 'clear-expired']);
    expect(exitCode, `analysis clear-expired failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(typeof parsed['deleted']).toBe('number');
  });

  it('writes an audit row for clear-expired (DoD §C)', async () => {
    await req('DELETE', '/v1/analysis-cache/expired', { token: AGENT_TOKEN });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/analysis-cache/expired') &&
        r['method'] === 'DELETE',
    );
    expect(found).toBeDefined();
  });

  it('exits 1 for dashboard token (write forbidden)', () => {
    const { exitCode } = cclaw(['analysis', 'clear-expired'], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — auth assertions
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/analysis-cache — auth assertions', () => {
  it('returns 200 for agent token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache', { token: AGENT_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 200 for dashboard token (read-only allowed)', async () => {
    const { status } = await req('GET', '/v1/analysis-cache', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/analysis-cache');
    expect(status).toBe(401);
  });
});
