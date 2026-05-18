/**
 * Integration tests for `cclaw system chains` and `cclaw system chain-config` subcommands.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 * DoD §C  — request lifecycle: auth, validation, response shape.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7911
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

const PORT = 7911;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-chains-test',
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
    tmpPrefix: 'cclaw-chains-cli-integration',
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
// cclaw system chains
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system chains — list', () => {
  it('exits 0 and outputs valid JSON', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'chains']);
    expect(exitCode, `system chains failed: ${stderr}`).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('response contains active and all arrays', () => {
    const { stdout } = cclaw(['system', 'chains']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(Array.isArray(parsed['active'])).toBe(true);
    expect(Array.isArray(parsed['all'])).toBe(true);
  });

  it('active contains base and solana (ACTIVE_CHAINS=base,solana)', () => {
    const { stdout } = cclaw(['system', 'chains']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const active = parsed['active'] as string[];
    expect(active).toContain('base');
    expect(active).toContain('solana');
  });

  it('all contains ethereum even though it is not in ACTIVE_CHAINS', () => {
    const { stdout } = cclaw(['system', 'chains']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    const all = parsed['all'] as string[];
    expect(all).toContain('ethereum');
  });
});

// ---------------------------------------------------------------------------
// cclaw system chain-config --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system chain-config --chain base', () => {
  it('exits 0 and returns config shape with name=base', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'chain-config', '--chain', 'base']);
    expect(exitCode, `system chain-config --chain base failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['name']).toBe('base');
    expect(parsed['type']).toBe('evm');
  });

  it('dex is 1inch for base chain', () => {
    const { stdout } = cclaw(['system', 'chain-config', '--chain', 'base']);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['dex']).toBe('1inch');
  });
});

describe.skipIf(!ENABLED)('cclaw system chain-config --chain solana', () => {
  it('exits 0 and returns solana config with chainId null', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'chain-config', '--chain', 'solana']);
    expect(exitCode, `system chain-config --chain solana failed: ${stderr}`).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['name']).toBe('solana');
    expect(parsed['chainId']).toBeNull();
    expect(parsed['dex']).toBe('jupiter');
  });
});

// ---------------------------------------------------------------------------
// Adversarial — missing required option and unknown chain
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system chain-config — adversarial', () => {
  it('exits non-zero when --chain is missing (Commander required option)', () => {
    const { exitCode } = cclaw(['system', 'chain-config']);
    expect(exitCode).not.toBe(0);
  });

  it('exits non-zero for unknown chain (API returns 404)', () => {
    const { exitCode, stderr } = cclaw(['system', 'chain-config', '--chain', 'notreal']);
    expect(exitCode, `should fail for unknown chain: ${stderr}`).not.toBe(0);
  });
});
