/**
 * Integration tests for `cclaw logs <agent>` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: logs executor|sentinel|research|observer list/get/append
 *
 * CRITICAL REGRESSION ASSERTION — three-level Commander nesting:
 *   `cclaw logs executor --help` must NOT crash at module load.
 *   This validates that logsCmd.command('executor').command('list') nesting works
 *   in Commander v14. Prior coder noted [OPEN-A] as the risk item.
 *   The helper `addAgentLogCommands()` in index.ts creates three-level nesting
 *   (program → logsCmd → agentCmd → actionCmd). This must not reproduce the
 *   double-registration bug that affected `system meta` (now fixed).
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7901
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

const PORT = 7901;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-logs-test',
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
    tmpPrefix: 'cclaw-logs-integration',
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

// ---------------------------------------------------------------------------
// CRITICAL REGRESSION: three-level Commander nesting must not crash at module load
// ---------------------------------------------------------------------------

describe('cclaw logs — three-level Commander nesting crash gate (no API required)', () => {
  it('cclaw logs executor --help exits 0 (module loads without Commander crash)', () => {
    let exitCode: number | null = null;
    let stderr = '';
    try {
      execFileSync('node', [CCLAW_BIN, 'logs', 'executor', '--help'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, CCLAW_API_TOKEN: 'dummy' },
      });
      exitCode = 0;
    } catch (e: unknown) {
      exitCode = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      stderr = (e as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    }
    // After Commander fix: exitCode === 0 (--help exits 0 in Commander v14).
    // If Commander nesting regressed: exitCode === 1, stderr contains registration error.
    expect(exitCode, `cclaw logs executor crashed: ${stderr}`).toBe(0);
  });

  it('cclaw logs sentinel --help exits 0', () => {
    let exitCode: number | null = null;
    let stderr = '';
    try {
      execFileSync('node', [CCLAW_BIN, 'logs', 'sentinel', '--help'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, CCLAW_API_TOKEN: 'dummy' },
      });
      exitCode = 0;
    } catch (e: unknown) {
      exitCode = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      stderr = (e as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    }
    expect(exitCode, `cclaw logs sentinel crashed: ${stderr}`).toBe(0);
  });

  it('cclaw logs research --help exits 0', () => {
    let exitCode: number | null = null;
    let stderr = '';
    try {
      execFileSync('node', [CCLAW_BIN, 'logs', 'research', '--help'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, CCLAW_API_TOKEN: 'dummy' },
      });
      exitCode = 0;
    } catch (e: unknown) {
      exitCode = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      stderr = (e as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    }
    expect(exitCode, `cclaw logs research crashed: ${stderr}`).toBe(0);
  });

  it('cclaw logs observer --help exits 0', () => {
    let exitCode: number | null = null;
    let stderr = '';
    try {
      execFileSync('node', [CCLAW_BIN, 'logs', 'observer', '--help'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, CCLAW_API_TOKEN: 'dummy' },
      });
      exitCode = 0;
    } catch (e: unknown) {
      exitCode = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      stderr = (e as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    }
    expect(exitCode, `cclaw logs observer crashed: ${stderr}`).toBe(0);
  });

  it('cclaw --help exits 0 (entire binary module loads)', () => {
    let exitCode: number | null = null;
    let stderr = '';
    try {
      execFileSync('node', [CCLAW_BIN, '--help'], {
        encoding: 'utf8',
        stdio: 'pipe',
        timeout: 5000,
        env: { ...process.env, CCLAW_API_TOKEN: 'dummy' },
      });
      exitCode = 0;
    } catch (e: unknown) {
      exitCode = (e as NodeJS.ErrnoException & { status?: number }).status ?? 1;
      stderr = (e as NodeJS.ErrnoException & { stderr?: string }).stderr ?? '';
    }
    expect(exitCode, `cclaw --help crashed: ${stderr}`).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// logs executor list
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw logs executor list', () => {
  it('exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['logs', 'executor', 'list']);
    expect(exitCode, `logs executor list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('exits 0 with --limit 10', () => {
    const { exitCode, stdout, stderr } = cclaw(['logs', 'executor', 'list', '--limit', '10']);
    expect(exitCode, `logs executor list --limit failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// logs executor append + get
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw logs executor append + get', () => {
  it('append exits 0 and returns the created row', () => {
    const body = JSON.stringify({ summary: 'test executor run', status: 'ok' });
    const { exitCode, stdout, stderr } = cclaw(['logs', 'executor', 'append', '--json', body]);
    expect(exitCode, `logs executor append failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['summary']).toBe('test executor run');
    expect(parsed['status']).toBe('ok');
    expect(typeof parsed['id']).toBe('number');
  });

  it('get by ID exits 0 and returns the appended row', async () => {
    const appendBody = JSON.stringify({ summary: 'executor get test', status: 'warn' });
    const appendRes = await req('POST', '/v1/logs/executor', {
      token: AGENT_TOKEN,
      body: { summary: 'executor get test', status: 'warn' },
    });
    const id = (appendRes.body as Record<string, unknown>)['id'] as number;

    const { exitCode, stdout, stderr } = cclaw(['logs', 'executor', 'get', '--id', String(id)]);
    expect(exitCode, `logs executor get failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['id']).toBe(id);
    expect(parsed['summary']).toBe('executor get test');
  });

  it('get by non-numeric ID exits 1 (StrictParseIntPipe rejects hex)', () => {
    const { exitCode } = cclaw(['logs', 'executor', 'get', '--id', '0xdeadbeef']);
    expect(exitCode).toBe(1);
  });

  it('get by non-existent ID exits 1 (404)', () => {
    const { exitCode } = cclaw(['logs', 'executor', 'get', '--id', '999999999']);
    expect(exitCode).toBe(1);
  });

  it('append exits 1 for invalid JSON', () => {
    const { exitCode, stderr } = cclaw(['logs', 'executor', 'append', '--json', '{bad}']);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('[cclaw] Error');
  });

  it('writes an audit row on append (DoD §C)', async () => {
    await req('POST', '/v1/logs/executor', {
      token: AGENT_TOKEN,
      body: { summary: 'audit-gate', status: 'ok' },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/logs/executor') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// logs sentinel list + append
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw logs sentinel list + append', () => {
  it('list exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['logs', 'sentinel', 'list']);
    expect(exitCode, `logs sentinel list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('append exits 0 and returns the row (requires check_type)', () => {
    // AppendSentinelLogDto requires check_type!: string (not optional)
    const body = JSON.stringify({ check_type: 'price_check', summary: 'sentinel test', status: 'ok' });
    const { exitCode, stdout, stderr } = cclaw(['logs', 'sentinel', 'append', '--json', body]);
    expect(exitCode, `logs sentinel append failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['summary']).toBe('sentinel test');
    expect(parsed['check_type']).toBe('price_check');
  });

  it('append exits 1 when check_type is missing (required field)', () => {
    // AppendSentinelLogDto requires check_type!: string
    const body = JSON.stringify({ summary: 'no check_type', status: 'ok' });
    const { exitCode } = cclaw(['logs', 'sentinel', 'append', '--json', body]);
    expect(exitCode).toBe(1);
  });

  it('append exits 1 for dashboard token (write forbidden)', () => {
    const body = JSON.stringify({ summary: 'forbidden', status: 'ok' });
    const { exitCode } = cclaw(['logs', 'sentinel', 'append', '--json', body], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// logs research list + append
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw logs research list + append', () => {
  it('list exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['logs', 'research', 'list']);
    expect(exitCode, `logs research list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('append exits 0 with required check_type field', () => {
    const body = JSON.stringify({ check_type: 'token_scan', summary: 'research test', status: 'ok' });
    const { exitCode, stdout, stderr } = cclaw(['logs', 'research', 'append', '--json', body]);
    expect(exitCode, `logs research append failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['check_type']).toBe('token_scan');
  });

  it('append exits 1 when check_type is missing (required field)', () => {
    // AppendResearchLogDto requires check_type!: string (not optional)
    const body = JSON.stringify({ summary: 'no check_type', status: 'ok' });
    const { exitCode } = cclaw(['logs', 'research', 'append', '--json', body]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// logs observer list + append
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw logs observer list + append', () => {
  it('list exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['logs', 'observer', 'list']);
    expect(exitCode, `logs observer list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('append exits 0 and returns the row', () => {
    const body = JSON.stringify({ summary: 'observer test', status: 'ok' });
    const { exitCode, stdout, stderr } = cclaw(['logs', 'observer', 'append', '--json', body]);
    expect(exitCode, `logs observer append failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(typeof parsed['id']).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — auth assertions
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/logs/executor — auth assertions', () => {
  it('returns 200 for agent token', async () => {
    const { status } = await req('GET', '/v1/logs/executor', { token: AGENT_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 200 for dashboard token (read-only allowed)', async () => {
    const { status } = await req('GET', '/v1/logs/executor', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/logs/executor');
    expect(status).toBe(401);
  });

  it('returns 403 for dashboard token on POST (write forbidden)', async () => {
    const { status } = await req('POST', '/v1/logs/executor', {
      token: DASHBOARD_TOKEN,
      body: { summary: 'forbidden', status: 'ok' },
    });
    expect(status).toBe(403);
  });
});
