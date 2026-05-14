import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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

// Detect if a local .env exists that would interfere with config-validation tests.
// The generated @prisma/client loads .env relative to its package __dirname, which
// resolves to the repo root .env. Tests that delete specific env vars and expect the
// process to fail on those vars must be skipped locally when .env can re-inject them.
// In CI (no local .env), all tests run as expected.
const LOCAL_ENV_EXISTS = existsSync(resolve(REPO_ROOT, '.env'));

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
  // DATABASE_URL must be set so @prisma/client doesn't fail during module load.
  DATABASE_URL: 'file::memory:?connection_limit=1',
  // Prevent @prisma/client from injecting SAFE_SIGNER_KEY from the local .env file.
  // The generated Prisma client resolves its schemaEnvPath relative to the package
  // __dirname, which points to the repo root's .env. Setting these to empty string
  // prevents dotenv from overriding them (dotenv skips vars already in env), and the
  // boot-check treats '' as "not set" (SPEC §4 #4, ADR-0010).
  SAFE_SIGNER_KEY: '',
  SQUADS_SIGNER_KEY: '',
  // PATH is needed for node resolution; NODE_PATH for module hoisting
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

function spawnNode(
  distPath: string,
  env: NodeJS.ProcessEnv,
  cwd?: string,
  stdinData?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((res) => {
    const child = spawn('node', [distPath], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
    // Write stdin and close if provided; otherwise close immediately (empty stdin)
    if (stdinData) {
      child.stdin.write(stdinData);
    }
    child.stdin.end();
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
    // Skip locally when .env exists: @prisma/client re-injects SAFE_ID from .env.
    if (LOCAL_ENV_EXISTS) return;
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
    if (LOCAL_ENV_EXISTS) return;
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
    if (LOCAL_ENV_EXISTS) return;
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

/**
 * Minimal valid order for executor stdin (P1c-i).
 * Provides enough fields for the executor to pass preflight checks.
 */
const VALID_EXECUTOR_ORDER = JSON.stringify({
  id: 'boot-test-order-001',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '100',
  entry_price: 2000,
  slippage_bps: 200,
  tier: 'conviction',
  expected_amount_out: 0.05,
});

describe('apps/executor — signer keys are permitted (ADR-0010)', () => {
  it('does NOT emit signer-key rejection when SAFE_SIGNER_KEY is set', async () => {
    // P1c-i: executor processes the order with signer key present.
    // With EXECUTOR_STUB_MODE=1, it should produce a success receipt.
    const result = await spawnNode(
      DIST.executor,
      {
        ...VALID_ENV,
        SAFE_SIGNER_KEY: 'some-signer-key-for-base-chain',
        EXECUTOR_STUB_MODE: '1',
      },
      undefined,
      VALID_EXECUTOR_ORDER,
    );
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(lastLine) as { status: string };
    expect(parsed.status).toBe('executed');
  });

  it('does NOT emit signer-key rejection when SQUADS_SIGNER_KEY is set for Solana order', async () => {
    const solanaOrder = JSON.stringify({
      id: 'boot-test-order-sol-001',
      action: 'buy',
      symbol: 'SOL',
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      amount: '100',
      entry_price: 150,
      slippage_bps: 200,
      tier: 'conviction',
      expected_amount_out: 0.666,
    });
    const result = await spawnNode(
      DIST.executor,
      {
        ...VALID_ENV,
        SQUADS_SIGNER_KEY: 'some-squads-signer-key-for-solana',
        EXECUTOR_STUB_MODE: '1',
      },
      undefined,
      solanaOrder,
    );
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(lastLine) as { status: string };
    expect(parsed.status).toBe('executed');
  });
});

describe('apps/executor — config validation', () => {
  it('exits 78 when SAFE_ID is unset', async () => {
    if (LOCAL_ENV_EXISTS) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnNode(DIST.executor, env, undefined, VALID_EXECUTOR_ORDER);
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });

  it('prints stub JSON receipt on success with EXECUTOR_STUB_MODE=1', async () => {
    // P1c-i: real executor produces a receipt via the stub path.
    const result = await spawnNode(
      DIST.executor,
      {
        ...VALID_ENV,
        SAFE_SIGNER_KEY: 'test-evm-signer-key-for-base-chain',
        EXECUTOR_STUB_MODE: '1',
      },
      undefined,
      VALID_EXECUTOR_ORDER,
    );
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(lastLine) as { status: string; tx_hash: string };
    expect(parsed.status).toBe('executed');
    expect(parsed.tx_hash).toMatch(/^0x[a-f0-9]{64}$/);
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
  it('exits 0 when both SAFE_SIGNER_KEY and SQUADS_SIGNER_KEY are set (P1c-i stub)', async () => {
    // Executor must not call assertNoSignerKeysInEnv at all. Setting both keys
    // simultaneously must still result in exit 0 with a valid stub receipt.
    const result = await spawnNode(
      DIST.executor,
      {
        ...VALID_ENV,
        SAFE_SIGNER_KEY: 'some-safe-key-for-base-chain',
        SQUADS_SIGNER_KEY: 'some-squads-key-for-solana',
        EXECUTOR_STUB_MODE: '1',
      },
      undefined,
      VALID_EXECUTOR_ORDER,
    );
    expect(result.code).toBe(0);
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
    const lines = result.stdout.trim().split('\n').filter(Boolean);
    const lastLine = lines[lines.length - 1] ?? '{}';
    const parsed = JSON.parse(lastLine) as { status: string };
    expect(parsed.status).toBe('executed');
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

// ---------------------------------------------------------------------------
// Docker image boot-defense (P0b — SPEC §4 invariant 4 + ADR-0010)
//
// Spawns the locally built prod image to assert that boot defenses run
// correctly inside the OCI image produced by docker/Dockerfile.
//
// Gated on CCLAW_TEST_LOCAL_DOCKER_IMAGE env var so the standard CI
// integration job (which has no Docker daemon) is unaffected.
// To exercise locally after building cclaw:p0b-smoke:
//   CCLAW_TEST_LOCAL_DOCKER_IMAGE=cclaw:p0b-smoke pnpm test:integration
// ---------------------------------------------------------------------------

const DOCKER_IMAGE = process.env['CCLAW_TEST_LOCAL_DOCKER_IMAGE'];

function spawnDocker(
  image: string,
  extraEnv: Record<string, string>,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((res) => {
    // Build -e flags from extraEnv
    const envFlags: string[] = [];
    for (const [k, v] of Object.entries(extraEnv)) {
      envFlags.push('-e', `${k}=${v}`);
    }
    const args = ['run', '--rm', '--platform', 'linux/amd64', ...envFlags, image, 'node', 'apps/api/dist/main.js'];
    const child = spawn('docker', args, {
      env: { PATH: process.env['PATH'] },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    let stdout = '';
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.on('close', (code) => { res({ code, stderr, stdout }); });
    // 15s: arm64 emulation startup is slow
    setTimeout(() => child.kill('SIGKILL'), 15000);
  });
}

// ---------------------------------------------------------------------------
// Route walker boot-defense (ADR-0019, SPEC §4 #3)
//
// The route walker runs onApplicationBootstrap and scans every controller
// method for @Roles and @Audited decorators. A missing decorator causes
// process.exit(78).
//
// The adversarial test (removing a decorator from a controller and rebuilding)
// is verified manually during code review because it requires a full
// tsc rebuild cycle. The unit tests in libs/auth/src/route-walker.service.spec.ts
// cover the walker logic with synthetic handlers.
//
// This test pins the happy-path: a clean boot of the compiled binary produces
// the route walker success message in stderr. If the walker is removed or
// silently disabled, this test catches the regression.
// ---------------------------------------------------------------------------

describe('apps/api — route walker success (SPEC §4 #3, ADR-0019)', () => {
  it('emits the route walker success message on a clean compiled-binary boot', async () => {
    // This test uses a timeout-based approach: the API starts up, emits the
    // success message, then the process is killed by the 10s timer.
    // We assert on the stderr captured before the process exits.
    //
    // Note: this test starts the API on port 7878. If another test has already
    // bound 7878 (e.g. the auth spec), this test will fail at the listen() call.
    // The integration job serialises the two test suites to avoid this conflict.
    const result = await spawnNode(DIST.api, VALID_ENV);

    // The walker runs and emits exactly this string on success (SPEC §4 #3).
    // If the walker is absent, the api boots without this message and the test fails.
    // If the walker finds a missing @Roles, it exits 78 BEFORE this message is emitted.
    expect(result.stderr).toContain('[boot] route walker: inspected');
    expect(result.stderr).toContain('all handlers decorated');
  });

  it('emits the exact controller count (20: Health, Positions, Orders, Receipts, Alerts, Heartbeat, Audit, Wallets, Signals, Liquidity, Watchlist, ResearchLog, SentinelLog, ExecutorLog, ObserverLog, AnalysisCache, Contracts, Meta, Cash, PortfolioSync)', async () => {
    const result = await spawnNode(DIST.api, VALID_ENV);
    // Pins the controller count so a future addition of an undecorated controller
    // would break the walker (it exits 78) or change the count (test catches the drift).
    // P1b added: ReceiptsController, AlertsController, HeartbeatController, AuditController = 7 total.
    // P2 group 1 added: WalletsController, SignalsController, LiquidityController, WatchlistController = 11 total.
    // P2 group 2 added: ResearchLogController, SentinelLogController, ExecutorLogController, ObserverLogController = 15 total.
    // P2 group 3 added: AnalysisCacheController, ContractsController, MetaController, CashController, PortfolioSyncController = 20 total.
    expect(result.stderr).toMatch(/\[boot\] route walker: inspected 20 controllers/);
  });
});

describe('prod Docker image — config boot-defense (P0b, SPEC §4 invariant 4)', () => {
  it.skipIf(!DOCKER_IMAGE)(
    'exits non-zero with [config] invalid env when no env vars are set',
    async () => {
      // When CCLAW_TEST_LOCAL_DOCKER_IMAGE is unset this test is skipped
      // so it never blocks the standard CI integration job.
      const result = await spawnDocker(DOCKER_IMAGE!, {});
      expect(result.code).not.toBe(0);
      expect(result.stderr + result.stdout).toMatch(/\[config\] invalid env/);
    },
  );
});

describe('prod Docker image — signer-key boot-defense (P0b, ADR-0010)', () => {
  it.skipIf(!DOCKER_IMAGE)(
    'exits non-zero with [boot] signer keys must not be present when SAFE_SIGNER_KEY is set',
    async () => {
      // Asserts that the signer-key isolation guard (ADR-0010) still fires
      // inside the published OCI image — not just the Node artifact tests above.
      // A Dockerfile change that accidentally copies signer-key env into the
      // image environment would surface here.
      const result = await spawnDocker(DOCKER_IMAGE!, { SAFE_SIGNER_KEY: 'test' });
      expect(result.code).not.toBe(0);
      expect(result.stderr + result.stdout).toContain(
        '[boot] signer keys must not be present',
      );
    },
  );
});
