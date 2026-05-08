import { describe, it, expect, beforeAll } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';

const DIST_MAIN = resolve(__dirname, '../dist/main.js');

let skipTests = false;

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

describe('apps/executor boot behavior (built artifact)', () => {
  it('exits 0 even when SAFE_SIGNER_KEY is set (executor is allowed to have signer keys)', async () => {
    if (skipTests) return;
    const result = await spawnNode([DIST_MAIN], {
      ...VALID_ENV,
      SAFE_SIGNER_KEY: 'test-signer-key-value',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
  });

  it('exits 78 with config error when SAFE_ID is unset', async () => {
    if (skipTests) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode([DIST_MAIN], env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });

  it('prints P0 stub JSON receipt on success', async () => {
    if (skipTests) return;
    const result = await spawnNode([DIST_MAIN], VALID_ENV);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('not_yet_implemented');
    expect(parsed.phase).toBe('P0');
  });
});
