/**
 * Integration tests for `cclaw system sync-status` subcommand.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, response shape.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7894
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

const PORT = 7894;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-sync-status-test',
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
    tmpPrefix: 'cclaw-sync-status-integration',
  });
}, 25_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
});

function cclawEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CCLAW_API_BASE: BASE,
    CCLAW_API_TOKEN: AGENT_TOKEN,
  };
}

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
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// cclaw system sync-status — no filters (all chains)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-status — no filters', () => {
  it('exits 0 and outputs a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'sync-status']);
    expect(exitCode, `sync-status failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });

  it('output is valid JSON (not empty string)', () => {
    const { stdout } = cclaw(['system', 'sync-status']);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// cclaw system sync-status --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-status --chain base', () => {
  it('exits 0 and returns an array (may be empty for fresh DB)', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'sync-status', '--chain', 'base']);
    expect(exitCode, `sync-status --chain base failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cclaw system sync-status --limit
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-status --limit', () => {
  it('exits 0 with --limit 5', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'sync-status', '--limit', '5']);
    expect(exitCode, `sync-status --limit failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — auth and response shape
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/sync-status — direct HTTP (auth assertions)', () => {
  it('returns 200 for agent token', async () => {
    const { status, body } = await req('GET', '/v1/system/sync-status', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
  });

  it('returns 200 for dashboard token (read-only allowed)', async () => {
    const { status } = await req('GET', '/v1/system/sync-status', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/system/sync-status');
    expect(status).toBe(401);
  });

  it('returns 400 for out-of-range limit (> 100)', async () => {
    const { status } = await req('GET', '/v1/system/sync-status?limit=999', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// cclaw system sync-status — passes chain and limit together
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-status --chain --limit combined', () => {
  it('exits 0 with both --chain and --limit', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'sync-status', '--chain', 'solana', '--limit', '10']);
    expect(exitCode, `sync-status combined flags failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
  });
});
