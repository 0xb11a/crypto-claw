import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

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
  cwd?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((res) => {
    const child = spawn('node', [distPath], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(cwd ? { cwd } : {}),
    });
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

// ---------------------------------------------------------------------------
// Adversarial edge cases (coder-flagged — SPEC §4 #4 + ADR-0010)
// ---------------------------------------------------------------------------

describe('apps/api — adversarial: empty SAFE_SIGNER_KEY must NOT reject (ADR-0010)', () => {
  it('exits non-zero for a config reason, not a signer-key reason, when SAFE_SIGNER_KEY is empty string', async () => {
    // Docker compose topology uses SAFE_SIGNER_KEY= (blank) to zero-out the
    // variable in api/worker/scheduler containers. An empty string must NOT
    // trigger the signer-key boot-check — only a non-empty value is forbidden.
    // The process will still fail here (no Redis) but the error must NOT be
    // the signer-key error.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, SAFE_SIGNER_KEY: '' });
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
  });
});

describe('apps/executor — adversarial: both signer keys set simultaneously (ADR-0010)', () => {
  it('exits 0 when both SAFE_SIGNER_KEY and SQUADS_SIGNER_KEY are set', async () => {
    // Executor must not call assertNoSignerKeysInEnv at all. Setting both keys
    // simultaneously must still result in exit 0 with the P0 stub JSON.
    const result = await spawnNode(DIST.executor, {
      ...VALID_ENV,
      SAFE_SIGNER_KEY: 'some-safe-key',
      SQUADS_SIGNER_KEY: 'some-squads-key',
    });
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
    const parsed = JSON.parse(result.stdout.trim());
    expect(parsed.status).toBe('not_yet_implemented');
  });
});

describe('apps/api — adversarial: ACTIVE_CHAINS empty string (SPEC §10)', () => {
  it('exits 78 with config error when ACTIVE_CHAINS is set to empty string', async () => {
    // An empty string (ACTIVE_CHAINS=) must be rejected the same way as missing.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, ACTIVE_CHAINS: '' });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: ACTIVE_CHAINS');
  });
});

describe('apps/api — adversarial: PAPER_STARTING_BALANCE=0 (SPEC §10)', () => {
  it('exits 78 with config error when PAPER_STARTING_BALANCE is 0', async () => {
    // Zero is not a valid starting balance; must be a positive number.
    const result = await spawnNode(DIST.api, {
      ...VALID_ENV,
      PAPER_STARTING_BALANCE: '0',
    });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: PAPER_STARTING_BALANCE');
  });
});

describe('apps/api — adversarial: ignoreEnvFile pins ConfigModule decision (SPEC §4 #4)', () => {
  it('boots without signer-key error when .env file in cwd contains SAFE_SIGNER_KEY but env var is absent', async () => {
    // This test pins the coder's edge case #1: ConfigModule.forRoot({ ignoreEnvFile: true })
    // must prevent @nestjs/config from loading .env files from disk.
    // If ignoreEnvFile were false, a .env file containing SAFE_SIGNER_KEY would
    // be loaded into process.env before the boot-check, causing a false positive.
    const tmpDir = mkdtempSync(resolve(tmpdir(), 'cclaw-test-'));
    try {
      // Write a .env file that would poison the env if dotenv were allowed to load it
      writeFileSync(
        resolve(tmpDir, '.env'),
        'SAFE_SIGNER_KEY=poisoned-by-dotenv-should-not-be-loaded\n',
      );
      // Spawn from that cwd — if ignoreEnvFile is working, the .env is ignored
      // and the signer-key check does NOT fire (the key is not in process.env).
      // The process may fail for other reasons (no Redis / NestJS startup) but
      // the stderr must NOT contain the signer-key error message.
      const result = await spawnNode(DIST.api, VALID_ENV, tmpDir);
      expect(result.stderr).not.toContain(
        '[boot] signer keys must not be present in this process env (got: SAFE_SIGNER_KEY)',
      );
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// New fields: LOG_LEVEL and NODE_ENV (SPEC §4 #6 — coder fix aec18d1)
// These tests pin the two new Zod fields that replaced direct process.env reads
// in libs/logger. If the schema reverts, these tests catch the regression.
// ---------------------------------------------------------------------------

describe('apps/api — LOG_LEVEL validation (SPEC §4 #6, libs/logger fix)', () => {
  it('exits 78 and emits [config] invalid env: LOG_LEVEL when LOG_LEVEL is invalid', async () => {
    // LOG_LEVEL is now a Zod enum in libs/config/src/schema.ts. An invalid value
    // must produce the canonical boot-fail string and exit 78.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, LOG_LEVEL: 'invalid' });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: LOG_LEVEL');
  });

  it('exits 78 when LOG_LEVEL=verbose (not in the allowed enum)', async () => {
    // 'verbose' is a common mistake (Winston/NestJS default) but is not a valid
    // pino level. The schema must reject it.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, LOG_LEVEL: 'verbose' });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: LOG_LEVEL');
  });
});

describe('apps/api — NODE_ENV validation (SPEC §4 #6, libs/logger fix)', () => {
  it('exits 78 and emits [config] invalid env: NODE_ENV when NODE_ENV=staging', async () => {
    // NODE_ENV is now a Zod enum. 'staging' is a common real-world value but is
    // not in the allowed set (development | production | test). Must boot-fail.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, NODE_ENV: 'staging' });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: NODE_ENV');
  });

  it('exits 78 when NODE_ENV=qa', async () => {
    // Belt-and-suspenders: another value outside the enum.
    const result = await spawnNode(DIST.api, { ...VALID_ENV, NODE_ENV: 'qa' });
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: NODE_ENV');
  });
});
