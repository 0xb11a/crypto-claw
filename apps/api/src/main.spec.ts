import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

/**
 * Integration-light boot-defense test for apps/api.
 *
 * Spawns the built artifact directly (requires `pnpm build` first).
 * These tests are the executable form of SPEC §19 #3.
 *
 * If the dist/ artifact doesn't exist (e.g., first clone before build),
 * the tests are skipped gracefully.
 */

const DIST_MAIN = resolve(__dirname, '../dist/main.js');
const REPO_ROOT = resolve(__dirname, '../../..');

let skipTests = false;
// Detect if a local .env exists that would interfere with config-validation tests
// (the generated @prisma/client loads .env relative to its package __dirname,
// which resolves to the repo root — see SAFE_SIGNER_KEY comment in VALID_ENV).
const LOCAL_ENV_EXISTS = existsSync(resolve(REPO_ROOT, '.env'));

beforeAll(() => {
  if (!existsSync(DIST_MAIN)) {
    skipTests = true;
  }
});

/**
 * Minimal env with only what the process needs — does NOT spread process.env
 * to avoid leaking SAFE_SIGNER_KEY or other secrets from the parent process.
 */
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
  // DATABASE_URL must be set so @prisma/client doesn't fail during module load.
  DATABASE_URL: 'file::memory:?connection_limit=1',
  // Prevent @prisma/client from injecting SAFE_SIGNER_KEY from the local .env file.
  // The generated Prisma client resolves its schemaEnvPath relative to the package
  // __dirname, which happens to point to the repo root's .env. Setting these to empty
  // string prevents dotenv from overriding them (dotenv skips vars already in env),
  // and the boot-check treats '' as "not set" (SPEC §4 #4). In CI there is no local
  // .env, so this has no effect there.
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
    // Kill after 8 s to avoid hanging the test suite
    setTimeout(() => child.kill(), 8000);
  });
}

describe('apps/api boot defenses (built artifact)', () => {
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
    // Skip this test locally when a .env exists in the repo root — the Prisma
    // generated client loads that file at import time (resolves schemaEnvPath
    // relative to __dirname), which may re-inject SAFE_ID and prevent the
    // assertConfigValid call from seeing SAFE_ID as missing. In CI (no .env)
    // the test runs as expected.
    if (LOCAL_ENV_EXISTS) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode([DIST_MAIN], env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });
});
