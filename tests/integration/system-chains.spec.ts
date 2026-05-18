/**
 * Integration tests for GET /v1/system/chains and GET /v1/system/chains/:chain.
 *
 * SPEC §7 — system module: chain configuration endpoints.
 * DoD §A  — behaviors flagged for coverage.
 * DoD §C  — request lifecycle: auth, validation, response shape.
 *
 * Key invariants:
 *   - GET /chains returns { active: string[], all: string[] }.
 *   - `active` reflects ACTIVE_CHAINS config (base,solana in this suite).
 *   - `all` reflects getAllChains() — includes ethereum even if not active.
 *   - GET /chains/base returns full config shape with required fields.
 *   - GET /chains/notreal returns 404.
 *   - GET /chains/BASE (uppercase) returns 404 — case-sensitive per @cclaw/chain getChain().
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7906
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { startApi } from './_spawn-api.js';
import type { StartApiResult } from './_spawn-api.js';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';

const AGENT_TOKEN = 'ci-research-key-aaaaaaaaaaaaaaaa';
const DASHBOARD_TOKEN = 'ci-dashboard-key-aaaaaaaaaaaaaaaa';

const PORT = 7906;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-chains-test',
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
    env: BASE_ENV,
    port: PORT,
    readyTimeoutMs: 20_000,
    tmpPrefix: 'cclaw-chains-integration',
  });
}, 25_000);

afterAll(async () => {
  if (!ENABLED) return;
  await api.kill();
});

async function req(
  method: string,
  path: string,
  opts: { token?: string } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const res = await fetch(`${BASE}${path}`, { method, headers });
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

// ---------------------------------------------------------------------------
// GET /v1/system/chains — list
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/chains — list', () => {
  it('returns 200 with { active, all } shape', async () => {
    const { status, body } = await req('GET', '/v1/system/chains', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(Array.isArray(b['active'])).toBe(true);
    expect(Array.isArray(b['all'])).toBe(true);
  });

  it('active reflects ACTIVE_CHAINS=base,solana', async () => {
    const { body } = await req('GET', '/v1/system/chains', { token: AGENT_TOKEN });
    const active = (body as Record<string, unknown>)['active'] as string[];
    expect(active).toContain('base');
    expect(active).toContain('solana');
    expect(active).not.toContain('ethereum');
  });

  it('all includes ethereum even though ACTIVE_CHAINS only has base,solana', async () => {
    const { body } = await req('GET', '/v1/system/chains', { token: AGENT_TOKEN });
    const all = (body as Record<string, unknown>)['all'] as string[];
    expect(all).toContain('base');
    expect(all).toContain('ethereum');
    expect(all).toContain('solana');
  });

  it('dashboard token receives 200', async () => {
    const { status } = await req('GET', '/v1/system/chains', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token', async () => {
    const { status } = await req('GET', '/v1/system/chains');
    expect(status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// GET /v1/system/chains/:chain — single chain config
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/chains/base — chain config', () => {
  it('returns 200 with required config fields', async () => {
    const { status, body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    const b = body as Record<string, unknown>;
    expect(b['name']).toBe('base');
    expect(b['type']).toBe('evm');
    expect(typeof b['chainId']).toBe('string');
    expect(b['dex']).toBe('1inch');
  });

  it('nativeToken field is present and has symbol + decimals', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const b = body as Record<string, unknown>;
    const native = b['nativeToken'] as Record<string, unknown>;
    expect(typeof native['symbol']).toBe('string');
    expect(typeof native['decimals']).toBe('number');
  });

  it('wrappedNativeToken field has symbol, address, decimals', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const wrapped = (body as Record<string, unknown>)['wrappedNativeToken'] as Record<string, unknown>;
    expect(typeof wrapped['symbol']).toBe('string');
    expect(typeof wrapped['address']).toBe('string');
    expect(typeof wrapped['decimals']).toBe('number');
  });

  it('cashToken field has symbol, address, decimals', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const cash = (body as Record<string, unknown>)['cashToken'] as Record<string, unknown>;
    expect(typeof cash['symbol']).toBe('string');
    expect(typeof cash['address']).toBe('string');
    expect(typeof cash['decimals']).toBe('number');
  });

  it('stablecoins is an array of strings', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const stables = (body as Record<string, unknown>)['stablecoins'] as unknown[];
    expect(Array.isArray(stables)).toBe(true);
    expect(stables.length).toBeGreaterThan(0);
    for (const s of stables) {
      expect(typeof s).toBe('string');
    }
  });

  it('rules object is present with portfolio rule fields', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const rules = (body as Record<string, unknown>)['rules'] as Record<string, unknown>;
    expect(rules).toBeDefined();
    // rules contains numeric portfolio constraints (field name per PortfolioRules interface)
    expect(typeof rules['minCashReserve']).toBe('number');
  });

  it('baseTierTokens is an array', async () => {
    const { body } = await req('GET', '/v1/system/chains/base', { token: AGENT_TOKEN });
    const tokens = (body as Record<string, unknown>)['baseTierTokens'];
    expect(Array.isArray(tokens)).toBe(true);
  });
});

describe.skipIf(!ENABLED)('GET /v1/system/chains/solana — solana chain has null chainId', () => {
  it('chainId is null for solana (SolanaChain.chainId === null)', async () => {
    const { status, body } = await req('GET', '/v1/system/chains/solana', { token: AGENT_TOKEN });
    expect(status).toBe(200);
    expect((body as Record<string, unknown>)['chainId']).toBeNull();
  });

  it('type is solana', async () => {
    const { body } = await req('GET', '/v1/system/chains/solana', { token: AGENT_TOKEN });
    expect((body as Record<string, unknown>)['type']).toBe('solana');
  });

  it('dex is jupiter', async () => {
    const { body } = await req('GET', '/v1/system/chains/solana', { token: AGENT_TOKEN });
    expect((body as Record<string, unknown>)['dex']).toBe('jupiter');
  });
});

// ---------------------------------------------------------------------------
// 404 cases
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/chains/:chain — 404 cases', () => {
  it('returns 404 for unknown chain', async () => {
    const { status } = await req('GET', '/v1/system/chains/notreal', { token: AGENT_TOKEN });
    expect(status).toBe(404);
  });

  it('returns 404 for uppercase BASE (case-sensitive)', async () => {
    const { status } = await req('GET', '/v1/system/chains/BASE', { token: AGENT_TOKEN });
    expect(status).toBe(404);
  });

  it('returns 404 for mixed-case chain names', async () => {
    const { status } = await req('GET', '/v1/system/chains/Base', { token: AGENT_TOKEN });
    expect(status).toBe(404);
  });
});

// ---------------------------------------------------------------------------
// Auth for /chains/:chain
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('GET /v1/system/chains/:chain — auth', () => {
  it('dashboard token receives 200 for known chain', async () => {
    const { status } = await req('GET', '/v1/system/chains/base', { token: DASHBOARD_TOKEN });
    expect(status).toBe(200);
  });

  it('returns 401 without token for known chain', async () => {
    const { status } = await req('GET', '/v1/system/chains/base');
    expect(status).toBe(401);
  });
});
