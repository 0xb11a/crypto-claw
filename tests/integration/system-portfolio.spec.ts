/**
 * Integration tests for GET /v1/system/portfolio.
 *
 * SPEC §7 — system module: portfolio snapshot endpoint.
 * DoD §A  — behaviors flagged for coverage; fails before route, passes after.
 * DoD §C  — request lifecycle: auth, validation, audit row (read-only route — no audit row
 *            written by GET; auth assertions still apply), response shape.
 *
 * SPEC §P5b plan, risk §6 — parity gate: all-chains mode must iterate getAllChains()
 *   (base + ethereum + solana) NOT just ACTIVE_CHAINS (base, solana).
 *   This test seeds ACTIVE_CHAINS=base,solana and then asserts that the response
 *   ALSO contains an "ethereum" key — proving getAllChains() is used.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7904
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from './_spawn-api.js';
import type { StartApiResult } from './_spawn-api.js';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';

const PORT = 7904;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-portfolio-test',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: 'ci-research-key-aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'ci-sentinel-key-aaaaaaaaaaaaaaaa',
  EXECUTOR_API_KEY: 'ci-executor-key-aaaaaaaaaaaaaaaa',
  OBSERVER_API_KEY: 'ci-observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: 'ci-loop-key-aaaaaaaaaaaaaaaaaaaaa',
  WORKER_API_KEY: 'ci-worker-key-aaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'ci-scheduler-key-aaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'ci-dashboard-key-aaaaaaaaaaaaaaaa',
  // NOTE: only base,solana — but all-chains response must also include ethereum
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
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-portfolio-integration',
  });
}, 25_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
});

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
// All-chains shape
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/portfolio — all chains', () => {
  it('returns 200 with { safe_id, chains, total_value, _mode }', async () => {
    const { status, body } = await req('GET', '/v1/system/portfolio', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b).toHaveProperty('safe_id');
    expect(b).toHaveProperty('chains');
    expect(typeof b['total_value']).toBe('number');
    expect(b['_mode']).toBe('real');
  });

  it('chains map contains base, ethereum, solana (getAllChains parity gate — ACTIVE_CHAINS=base,solana only)', async () => {
    // SPEC §P5b plan risk §6: iterates getAllChains() not ACTIVE_CHAINS.
    // With ACTIVE_CHAINS=base,solana, if getPortfolioAllChains() incorrectly
    // used ACTIVE_CHAINS, the "ethereum" key would be absent.
    const { body } = await req('GET', '/v1/system/portfolio', { token: AGENT_TOKEN });
    const chains = (body as Record<string, unknown>)['chains'] as Record<string, unknown>;
    expect(chains).toHaveProperty('base');
    expect(chains).toHaveProperty('ethereum');
    expect(chains).toHaveProperty('solana');
  });

  it('each chain slice has { cash, positions, total_value }', async () => {
    const { body } = await req('GET', '/v1/system/portfolio', { token: AGENT_TOKEN });
    const chains = (body as Record<string, unknown>)['chains'] as Record<string, Record<string, unknown>>;
    for (const [, slice] of Object.entries(chains)) {
      expect(typeof slice['cash']).toBe('number');
      expect(Array.isArray(slice['positions'])).toBe(true);
      expect(typeof slice['total_value']).toBe('number');
    }
  });

  it('empty state: chain with no positions has { cash: 0, positions: [], total_value: 0 }', async () => {
    const { body } = await req('GET', '/v1/system/portfolio', { token: AGENT_TOKEN });
    const chains = (body as Record<string, unknown>)['chains'] as Record<string, Record<string, unknown>>;
    // Fresh DB → all chains should be empty
    const ethereum = chains['ethereum']!;
    expect(ethereum['cash']).toBe(0);
    expect(ethereum['positions']).toEqual([]);
    expect(ethereum['total_value']).toBe(0);
  });

  it('dashboard token receives 200', async () => {
    const { status } = await req('GET', '/v1/system/portfolio', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/system/portfolio');
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// Single-chain shape
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/portfolio?chain=base — single chain', () => {
  it('returns 200 with { safe_id, chain, cash, total_deposited, positions, total_value, _mode }', async () => {
    const { status, body } = await req('GET', '/v1/system/portfolio?chain=base', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['chain']).toBe('base');
    expect(typeof b['cash']).toBe('number');
    expect(b).toHaveProperty('total_deposited');
    expect(Array.isArray(b['positions'])).toBe(true);
    expect(typeof b['total_value']).toBe('number');
    expect(b['_mode']).toBe('real');
  });

  it('total_deposited is present and is a number (optional field per DTO)', async () => {
    const { body } = await req('GET', '/v1/system/portfolio?chain=base', { token: AGENT_TOKEN });
    const b = body as Record<string, unknown>;
    expect(typeof b['total_deposited']).toBe('number');
  });

  it('safe_id matches the SAFE_ID env (seeded at boot)', async () => {
    const { body } = await req('GET', '/v1/system/portfolio?chain=base', { token: AGENT_TOKEN });
    const b = body as Record<string, unknown>;
    expect(b['safe_id']).toBe('ci-portfolio-test');
  });
});

// ---------------------------------------------------------------------------
// Paper mode
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/portfolio?mode=paper — paper mode override', () => {
  it('returns 200 with _mode: paper when mode=paper is supplied', async () => {
    const { status, body } = await req('GET', '/v1/system/portfolio?mode=paper', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['_mode']).toBe('paper');
  });

  it('returns 200 with _mode: real when mode=real is supplied', async () => {
    const { status, body } = await req('GET', '/v1/system/portfolio?mode=real', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['_mode']).toBe('real');
  });

  it('returns 200 with _mode: paper for single chain + mode=paper', async () => {
    const { status, body } = await req('GET', '/v1/system/portfolio?chain=solana&mode=paper', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['_mode']).toBe('paper');
    expect(b['chain']).toBe('solana');
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/portfolio — validation', () => {
  it('returns 400 for invalid mode value', async () => {
    const { status } = await req('GET', '/v1/system/portfolio?mode=garbage', { token: AGENT_TOKEN });
    expect(status).toBe(400);
  });
});
