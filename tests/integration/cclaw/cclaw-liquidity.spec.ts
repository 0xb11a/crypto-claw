/**
 * Integration tests for `cclaw liquidity` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: liquidity list, liquidity add
 *
 * BODY FIELD VERIFICATION:
 *   The CLI sends `liquidity_usd` (snake_case) to match AddLiquiditySnapshotDto.
 *   AddLiquiditySnapshotDto field: `liquidity_usd!: number` @IsNumber() @Min(0)
 *   Source: libs/modules/liquidity/src/dto/add-liquidity-snapshot.dto.ts
 *   CLI source (index.ts ~line 710): `liquidity_usd: liquidity_usd`
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7898
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

const PORT = 7898;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-liquidity-test',
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
    tmpPrefix: 'cclaw-liquidity-integration',
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

const TEST_ADDRESS = '0xaabbccdd000000000000000000000000deadbeef';
const TEST_CHAIN = 'base';

// ---------------------------------------------------------------------------
// liquidity list — no filters
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw liquidity list', () => {
  it('exits 0 and returns a JSON array', () => {
    const { exitCode, stdout, stderr } = cclaw(['liquidity', 'list']);
    expect(exitCode, `liquidity list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('exits 0 with --address and --chain filters', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'liquidity', 'list',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
    ]);
    expect(exitCode, `liquidity list --address --chain failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('exits 0 with --limit flag', () => {
    const { exitCode, stdout, stderr } = cclaw(['liquidity', 'list', '--limit', '5']);
    expect(exitCode, `liquidity list --limit failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// liquidity add — happy path
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw liquidity add', () => {
  it('exits 0 and returns { ok: true }', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'liquidity', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--liquidity', '50000',
    ]);
    expect(exitCode, `liquidity add failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });

  it('exits 0 with zero liquidity (boundary: @Min(0) allows 0)', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'liquidity', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--liquidity', '0',
    ]);
    expect(exitCode, `liquidity add --liquidity 0 failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['ok']).toBe(true);
  });

  it('exits 1 for negative liquidity (client-side guard)', () => {
    const { exitCode, stderr } = cclaw([
      'liquidity', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--liquidity', '-1',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--liquidity must be a non-negative number');
  });

  it('exits 1 for non-numeric liquidity (client-side guard)', () => {
    const { exitCode, stderr } = cclaw([
      'liquidity', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--liquidity', 'notanumber',
    ]);
    expect(exitCode).toBe(1);
    expect(stderr).toContain('--liquidity must be a non-negative number');
  });

  it('exits 1 when --address is missing', () => {
    const { exitCode } = cclaw(['liquidity', 'add', '--chain', TEST_CHAIN, '--liquidity', '1000']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --chain is missing', () => {
    const { exitCode } = cclaw(['liquidity', 'add', '--address', TEST_ADDRESS, '--liquidity', '1000']);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --liquidity is missing', () => {
    const { exitCode } = cclaw(['liquidity', 'add', '--address', TEST_ADDRESS, '--chain', TEST_CHAIN]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', () => {
    const { exitCode } = cclaw([
      'liquidity', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--liquidity', '1000',
    ], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row on add (DoD §C)', async () => {
    await req('POST', '/v1/liquidity', {
      token: AGENT_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, liquidity_usd: 99999 },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/liquidity') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// Body field name verification: CLI sends liquidity_usd (not liquidity)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('POST /v1/liquidity — body field name verification', () => {
  it('returns 201 when body uses liquidity_usd (correct DTO field)', async () => {
    const { status, body } = await req('POST', '/v1/liquidity', {
      token: AGENT_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, liquidity_usd: 12345 },
    });
    expect(status).toBe(201);
    expect((body as Record<string, unknown>)['ok']).toBe(true);
  });

  it('returns 400 when body uses liquidity instead of liquidity_usd (wrong field)', async () => {
    // If the CLI sent "liquidity" instead of "liquidity_usd", the DTO would reject it.
    // This test documents the correct contract and would catch a regression if the
    // CLI field name reverted to "liquidity".
    const { status } = await req('POST', '/v1/liquidity', {
      token: AGENT_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, liquidity: 12345 },
    });
    expect(status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('POST', '/v1/liquidity', {
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, liquidity_usd: 100 },
    });
    expect(status).toBe(401);
  });

  it('returns 403 for dashboard token', async () => {
    const { status } = await req('POST', '/v1/liquidity', {
      token: DASHBOARD_TOKEN,
      body: { address: TEST_ADDRESS, chain: TEST_CHAIN, liquidity_usd: 100 },
    });
    expect(status).toBe(403);
  });
});
