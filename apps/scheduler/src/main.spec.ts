import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const REPO_ROOT = resolve(__dirname, '../../..');
const DIST_MAIN = resolve(__dirname, '../dist/main.js');

let skipTests = false;

// When a local .env exists, @prisma/client auto-loads it into process.env
// before PRISMA_DISABLE_DOTENV can block it. Tests that remove env vars
// (e.g. delete env.SAFE_ID) would incorrectly pass because .env re-injects
// SAFE_ID. Skip those tests locally; they run in CI (no local .env).
const LOCAL_ENV_EXISTS = existsSync(resolve(REPO_ROOT, '.env'));

beforeAll(() => {
  if (!existsSync(DIST_MAIN)) {
    skipTests = true;
  }
});

const VALID_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-test',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1',
  SENTINEL_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa2',
  EXECUTOR_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa3',
  OBSERVER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa4',
  LOOP_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa5',
  WORKER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa6',
  SCHEDULER_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa7',
  DASHBOARD_API_KEY: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa8',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-dummy',
  // Prevent @prisma/client from auto-loading repo-root .env (mirrors apps/api pattern)
  PRISMA_DISABLE_DOTENV: '1',
  // DATABASE_URL must be set so @prisma/client doesn't fail during module load
  DATABASE_URL: 'file::memory:?connection_limit=1',
  // Blank signer keys (empty = not set per boot-check semantics; SPEC §4 #4, ADR-0010)
  SAFE_SIGNER_KEY: '',
  SQUADS_SIGNER_KEY: '',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

function spawnNode(
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', (code) => {
      resolve({ code, stderr, stdout });
    });
    setTimeout(() => child.kill(), 8000);
  });
}

describe('apps/scheduler boot defenses (built artifact)', () => {
  it('exits non-zero with signer-key error when SAFE_SIGNER_KEY is set', async () => {
    if (skipTests) return;
    const result = await spawnNode([DIST_MAIN], {
      ...VALID_ENV,
      SAFE_SIGNER_KEY: 'test-signer-key-value',
    });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('[boot] signer keys must not be present');
  });

  it('exits 78 with config error when SAFE_ID is unset', async () => {
    if (skipTests) return;
    // Skip locally: @prisma/client auto-loads .env which re-injects SAFE_ID
    // before PRISMA_DISABLE_DOTENV takes effect. Runs cleanly in CI (no .env).
    if (LOCAL_ENV_EXISTS) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode([DIST_MAIN], env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });
});
