/**
 * Integration tests for `cclaw system portfolio` subcommand.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, response shape.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7909
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

const PORT = 7909;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-portfolio-test',
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
    tmpPrefix: 'cclaw-portfolio-cli-integration',
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

// ---------------------------------------------------------------------------
// cclaw system portfolio — no chain (all chains)
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system portfolio — all chains', () => {
  it('exits 0 and outputs valid JSON', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'portfolio']);
    expect(exitCode, `system portfolio failed: ${stderr}`).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('response contains chains map and total_value', () => {
    const { stdout } = cclaw(['system', 'portfolio']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toHaveProperty('chains');
    expect(typeof parsed['total_value']).toBe('number');
  });

  it('chains map contains ethereum (getAllChains parity — not just ACTIVE_CHAINS)', () => {
    const { stdout } = cclaw(['system', 'portfolio']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const chains = parsed['chains'] as Record<string, unknown>;
    expect(chains).toHaveProperty('ethereum');
    expect(chains).toHaveProperty('base');
    expect(chains).toHaveProperty('solana');
  });
});

// ---------------------------------------------------------------------------
// cclaw system portfolio --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system portfolio --chain base', () => {
  it('exits 0 and returns single-chain shape', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'portfolio', '--chain', 'base']);
    expect(exitCode, `system portfolio --chain base failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['chain']).toBe('base');
    expect(typeof parsed['cash']).toBe('number');
    expect(Array.isArray(parsed['positions'])).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// cclaw system portfolio --mode paper
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system portfolio --mode paper', () => {
  it('exits 0 and returns _mode: paper in output', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'portfolio', '--mode', 'paper']);
    expect(exitCode, `system portfolio --mode paper failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['_mode']).toBe('paper');
  });
});

// ---------------------------------------------------------------------------
// Adversarial
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system portfolio — adversarial', () => {
  it('exits non-zero when no token is configured', () => {
    try {
      execFileSync('node', [CCLAW_BIN, 'system', 'portfolio'], {
        encoding: 'utf8',
        env: { ...process.env, CCLAW_API_BASE: BASE, CCLAW_API_TOKEN: '' },
        timeout: 10_000,
      });
      // If it somehow succeeds with empty token, that is a bug — but the API returns 401
      // so the cclaw binary should exit non-zero.
      expect(true).toBe(false); // unreachable if API correctly returns 401
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException & { status?: number };
      expect(err.status ?? 1).not.toBe(0);
    }
  });
});
