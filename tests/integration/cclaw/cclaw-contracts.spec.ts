/**
 * Integration tests for `cclaw contracts` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, audit row, response shape.
 *
 * Covers: contracts list, contracts add
 *
 * IMPORTANT: AddContractSnapshotDto.json is a @IsString() field (raw GoPlus blob),
 * NOT a parsed JSON object. The CLI sends the --json flag value AS A STRING directly
 * in the `json` body field. See libs/modules/contracts/src/dto/add-contract-snapshot.dto.ts.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7897
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

const PORT = 7897;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-contracts-test',
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
    tmpPrefix: 'cclaw-contracts-integration',
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

const TEST_ADDRESS = '0x1234567890abcdef1234567890abcdef12345678';
const TEST_CHAIN = 'base';
// A valid GoPlus-style blob — json field is a raw string, not parsed JSON
const SAMPLE_GOPLUS_BLOB = JSON.stringify({ is_honeypot: 0, buy_tax: 0, sell_tax: 0 });

// ---------------------------------------------------------------------------
// contracts list — requires --address and --chain
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw contracts list', () => {
  it('exits 0 and returns a JSON array (may be empty for fresh DB)', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'contracts', 'list',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
    ]);
    expect(exitCode, `contracts list failed: ${stderr}`).toBe(0);
    expect(Array.isArray(JSON.parse(stdout))).toBe(true);
  });

  it('exits 1 when --address is missing', () => {
    const { exitCode } = cclaw(['contracts', 'list', '--chain', TEST_CHAIN]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --chain is missing', () => {
    const { exitCode } = cclaw(['contracts', 'list', '--address', TEST_ADDRESS]);
    expect(exitCode).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// contracts add — happy path
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw contracts add', () => {
  it('exits 0 and returns the created snapshot shape', () => {
    const { exitCode, stdout, stderr } = cclaw([
      'contracts', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--json', SAMPLE_GOPLUS_BLOB,
    ]);
    expect(exitCode, `contracts add failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['address']).toBe(TEST_ADDRESS);
    expect(parsed['chain']).toBe(TEST_CHAIN);
    // Response DTO uses safety_data (the stored field name), not json (the input field name)
    // ContractSnapshotResponseDto: id, address, chain, safety_data, checked_at
    expect(typeof parsed['safety_data']).toBe('string');
  });

  it('exits 1 when --address is missing', () => {
    const { exitCode } = cclaw(['contracts', 'add', '--chain', TEST_CHAIN, '--json', SAMPLE_GOPLUS_BLOB]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --chain is missing', () => {
    const { exitCode } = cclaw(['contracts', 'add', '--address', TEST_ADDRESS, '--json', SAMPLE_GOPLUS_BLOB]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 when --json is missing', () => {
    const { exitCode } = cclaw(['contracts', 'add', '--address', TEST_ADDRESS, '--chain', TEST_CHAIN]);
    expect(exitCode).toBe(1);
  });

  it('exits 1 for dashboard token (write forbidden)', () => {
    const { exitCode } = cclaw([
      'contracts', 'add',
      '--address', TEST_ADDRESS,
      '--chain', TEST_CHAIN,
      '--json', SAMPLE_GOPLUS_BLOB,
    ], DASHBOARD_TOKEN);
    expect(exitCode).toBe(1);
  });

  it('writes an audit row on add (DoD §C)', async () => {
    const addr = '0x' + 'a'.repeat(40);
    await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: addr, chain: 'base', json: SAMPLE_GOPLUS_BLOB },
    });
    const { body } = await req('GET', '/v1/system/audit', { token: AGENT_TOKEN });
    const rows = (body as { data: Array<Record<string, unknown>> }).data;
    const found = rows.find(
      (r) =>
        typeof r['path'] === 'string' &&
        r['path'].includes('/v1/contracts/snapshots') &&
        r['method'] === 'POST',
    );
    expect(found).toBeDefined();
    expect(found!['status']).toBe(201);
  });

  it('round-trip: list after add returns the snapshot', async () => {
    const addr = '0xroundtrip0000000000000000000000000000001';
    await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: addr, chain: 'base', json: SAMPLE_GOPLUS_BLOB },
    });
    const { exitCode, stdout, stderr } = cclaw([
      'contracts', 'list',
      '--address', addr,
      '--chain', 'base',
    ]);
    expect(exitCode, `contracts list after add failed: ${stderr}`).toBe(0);
    const rows = JSON.parse(stdout) as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!['address']).toBe(addr);
  });
});

// ---------------------------------------------------------------------------
// Direct HTTP — AddContractSnapshotDto.json is @IsString() (raw blob, not parsed)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('POST /v1/contracts/snapshots — dto.json is @IsString() (spec assertion)', () => {
  it('returns 201 when json field is a raw string (correct DTO shape)', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x' + 'b'.repeat(40), chain: 'base', json: '{"is_honeypot":0}' },
    });
    expect(status).toBe(201);
  });

  it('returns 400 when json field is absent', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: AGENT_TOKEN,
      body: { address: '0x' + 'c'.repeat(40), chain: 'base' },
    });
    expect(status).toBe(400);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      body: { address: TEST_ADDRESS, chain: 'base', json: SAMPLE_GOPLUS_BLOB },
    });
    expect(status).toBe(401);
  });

  it('returns 403 for dashboard token', async () => {
    const { status } = await req('POST', '/v1/contracts/snapshots', {
      token: DASHBOARD_TOKEN,
      body: { address: TEST_ADDRESS, chain: 'base', json: SAMPLE_GOPLUS_BLOB },
    });
    expect(status).toBe(403);
  });
});
