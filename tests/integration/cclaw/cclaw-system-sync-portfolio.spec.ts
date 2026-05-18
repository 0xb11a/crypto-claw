/**
 * Integration tests for `cclaw system sync-portfolio` subcommand.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, response shape.
 * DoD §E  — fires twice, DB state unchanged (enqueue-only, no worker in test env).
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7912
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

const PORT = 7912;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * Real-mode API instance (no PAPER_MODE env).
 */
const BASE_ENV_REAL: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-sync-portfolio-test',
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
  PAPER_MODE: 'false',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

let api: StartApiResult;

beforeAll(async () => {
  if (!ENABLED) return;
  api = await startApi({
    dbPath: '',
    env: BASE_ENV_REAL,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-sync-portfolio-cli-integration',
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
// cclaw system sync-portfolio --chain base (real mode)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-portfolio --chain base — real mode', () => {
  it('exits 0 and outputs valid JSON with ok:true', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'sync-portfolio', '--chain', 'base']);
    expect(exitCode, `system sync-portfolio --chain base failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['queued']).toBe(true);
    expect(typeof parsed['jobId']).toBe('string');
  });

  it('jobId is a non-empty string', () => {
    const { stdout } = cclaw(['system', 'sync-portfolio', '--chain', 'base']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect((parsed['jobId'] as string).length).toBeGreaterThan(0);
  });

  it('--trigger periodic is accepted', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'system', 'sync-portfolio', '--chain', 'base', '--trigger', 'periodic',
    ]);
    expect(exitCode, `periodic trigger failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });

  it('--trigger post_trade is accepted', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'system', 'sync-portfolio', '--chain', 'base', '--trigger', 'post_trade',
    ]);
    expect(exitCode, `post_trade trigger failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Paper mode short-circuit via direct HTTP
// (We cannot easily pass PAPER_MODE=true to the CLI against a real-mode API
// instance because PAPER_MODE is read server-side. We verify paper behavior
// via HTTP to a paper-mode server endpoint in system-sync-portfolio.spec.ts.
// Here we verify that real-mode response shape differs from paper shape.)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-portfolio — real mode has ok:true (not paper shape)', () => {
  it('real mode response does not contain message field (paper-only)', () => {
    const { stdout } = cclaw(['system', 'sync-portfolio', '--chain', 'base']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
    expect(parsed['message']).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DoD §E — CLI idempotency proof
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-portfolio — CLI idempotency (DoD §E)', () => {
  it('running sync-portfolio twice does not corrupt DB cash state', async () => {
    // Seed known cash value
    await req('PATCH', '/v1/system/cash', {
      token: AGENT_TOKEN,
      body: { chain: 'base', amount: 1234 },
    });

    // Run cclaw sync-portfolio twice
    cclaw(['system', 'sync-portfolio', '--chain', 'base']);
    cclaw(['system', 'sync-portfolio', '--chain', 'base']);

    // Verify cash unchanged (enqueue does not modify DB)
    // Cash route is /v1/system/cash/:chain (path param, not query string)
    const { body } = await req('GET', '/v1/system/cash/base', { token: AGENT_TOKEN });
    const b = body as Record<string, unknown>;
    expect(b['cash']).toBe(1234);
  });
});

// ---------------------------------------------------------------------------
// Adversarial
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system sync-portfolio — adversarial', () => {
  it('exits non-zero when --chain is missing (Commander required option)', () => {
    const { exitCode } = cclaw(['system', 'sync-portfolio']);
    expect(exitCode).not.toBe(0);
  });

  it('exits non-zero with dashboard token (403 → cclaw exits 1)', () => {
    try {
      execFileSync('node', [CCLAW_BIN, 'system', 'sync-portfolio', '--chain', 'base'], {
        encoding: 'utf8',
        env: { ...process.env, CCLAW_API_BASE: BASE, CCLAW_API_TOKEN: DASHBOARD_TOKEN },
        timeout: 10_000,
      });
      // If it exits 0 with dashboard token, that would be a security bug
      expect(true).toBe(false);
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException & { status?: number };
      expect(err.status ?? 1).not.toBe(0);
    }
  });

  it('exits non-zero for invalid trigger value (API returns 400)', () => {
    const { exitCode } = cclaw([
      'system', 'sync-portfolio', '--chain', 'base', '--trigger', 'INVALID',
    ]);
    expect(exitCode).not.toBe(0);
  });
});
