import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Boot-defense integration tests — SPEC §19 #3.
 *
 * Verifies that:
 * 1. api, worker, and scheduler exit non-zero when SAFE_SIGNER_KEY is present.
 * 2. All four apps exit 78 when SAFE_ID is unset.
 * 3. executor exits 0 even when SAFE_SIGNER_KEY is present (ADR-0010).
 *
 * Requires a prior `pnpm build` to have produced dist/ artifacts.
 * Run via `pnpm test:integration`.
 */

const REPO_ROOT = resolve(__dirname, '../..');

const DIST = {
  api: resolve(REPO_ROOT, 'apps/api/dist/main.js'),
  worker: resolve(REPO_ROOT, 'apps/worker/dist/main.js'),
  scheduler: resolve(REPO_ROOT, 'apps/scheduler/dist/main.js'),
  executor: resolve(REPO_ROOT, 'apps/executor/dist/main.js'),
};

/**
 * Minimal valid env that passes Zod schema.
 * Does NOT spread process.env to avoid inheriting secrets from the parent.
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
  // PATH is needed for node resolution; NODE_PATH for module hoisting
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

function spawnNode(
  distPath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((res) => {
    const child = spawn('node', [distPath], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.on('close', (code) => {
      res({ code, stderr, stdout });
    });
    // Kill after 10 s — NestJS apps with Redis may take a moment to fail
    setTimeout(() => child.kill('SIGKILL'), 10000);
  });
}

// ---------------------------------------------------------------------------
// api
// ---------------------------------------------------------------------------

describe('apps/api — signer-key isolation (ADR-0010)', () => {
  it('exits non-zero and emits the literal error string when SAFE_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.api, { ...VALID_ENV, SAFE_SIGNER_KEY: 'secret' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      '[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)',
    );
  });

  it('exits non-zero when SQUADS_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.api, { ...VALID_ENV, SQUADS_SIGNER_KEY: 'secret' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      '[boot] signer keys must not be present in this process env (got: SQUADS_SIGNER_KEY)',
    );
  });
});

describe('apps/api — config validation (SPEC §4 #6)', () => {
  it('exits 78 and emits the literal error string when SAFE_ID is unset', async () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode(DIST.api, env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });
});

// ---------------------------------------------------------------------------
// worker
// ---------------------------------------------------------------------------

describe('apps/worker — signer-key isolation (ADR-0010)', () => {
  it('exits non-zero when SAFE_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.worker, { ...VALID_ENV, SAFE_SIGNER_KEY: 'secret' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      '[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)',
    );
  });
});

describe('apps/worker — config validation', () => {
  it('exits 78 when SAFE_ID is unset', async () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode(DIST.worker, env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });
});

// ---------------------------------------------------------------------------
// scheduler
// ---------------------------------------------------------------------------

describe('apps/scheduler — signer-key isolation (ADR-0010)', () => {
  it('exits non-zero when SAFE_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.scheduler, { ...VALID_ENV, SAFE_SIGNER_KEY: 'secret' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain(
      '[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)',
    );
  });
});

describe('apps/scheduler — config validation', () => {
  it('exits 78 when SAFE_ID is unset', async () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode(DIST.scheduler, env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });
});

// ---------------------------------------------------------------------------
// executor — MUST allow signer keys (ADR-0010)
// ---------------------------------------------------------------------------

describe('apps/executor — signer keys are permitted (ADR-0010)', () => {
  it('exits 0 even when SAFE_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.executor, {
      ...VALID_ENV,
      SAFE_SIGNER_KEY: 'some-signer-key',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
  });

  it('exits 0 even when SQUADS_SIGNER_KEY is set', async () => {
    const result = await spawnNode(DIST.executor, {
      ...VALID_ENV,
      SQUADS_SIGNER_KEY: 'some-signer-key',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
  });
});

describe('apps/executor — config validation', () => {
  it('exits 78 when SAFE_ID is unset', async () => {
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode(DIST.executor, env);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });

  it('prints P0 stub JSON on success', async () => {
    const result = await spawnNode(DIST.executor, VALID_ENV);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('not_yet_implemented');
    expect(parsed.phase).toBe('P0');
  });
});
