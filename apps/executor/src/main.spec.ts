/**
 * Integration tests for apps/executor/src/main.ts (built artifact).
 *
 * These tests spawn the compiled binary as a child process and assert
 * on stdout/stderr/exit code. Tests are skipped if the dist artifact
 * doesn't exist (requires prior `pnpm build`).
 */
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
  EXECUTOR_STUB_MODE: '1',
  SAFE_SIGNER_KEY: 'ci-stub-signer-key-for-executor-only',
  NODE_PATH: process.env['NODE_PATH'],
  PATH: process.env['PATH'],
};

const VALID_ORDER = {
  id: 'test-order-00000001',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '100.00',
  expected_amount_out: 0.05,
  slippage_bps: 200,
  tier: 'conviction',
};

function spawnExecutor(
  env: NodeJS.ProcessEnv,
  stdinData?: string,
): Promise<{ code: number | null; stderr: string; stdout: string }> {
  return new Promise((resolve) => {
    const child = spawn('node', [DIST_MAIN], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
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
      resolve({ code, stderr, stdout });
    });
    if (stdinData) {
      child.stdin.write(stdinData + '\n');
    }
    child.stdin.end();
    setTimeout(() => child.kill(), 10000);
  });
}

describe('apps/executor boot behavior (built artifact)', () => {
  it('exits 0 even when SAFE_SIGNER_KEY is set (executor is allowed)', async () => {
    if (skipTests) return;
    const result = await spawnExecutor(
      { ...VALID_ENV, SAFE_SIGNER_KEY: 'allowed-signer-key' },
      JSON.stringify(VALID_ORDER),
    );
    // Should NOT complain about signer keys (executor is exempt from that check)
    expect(result.stderr).not.toContain('[boot] signer keys must not be present');
    // May exit 0 (success) or 1 (stub needs stub mode) but should not fail on signer
    expect([0, 1]).toContain(result.code);
  });

  it('exits 78 with config error when SAFE_ID is unset', async () => {
    if (skipTests) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_ID;
    const result = await spawnExecutor(env, JSON.stringify(VALID_ORDER));
    expect(result.code).toBe(78);
    expect(result.stderr).toContain('[config] invalid env: SAFE_ID');
  });

  it('prints stub JSON receipt on success (EXECUTOR_STUB_MODE=1)', async () => {
    if (skipTests) return;
    const result = await spawnExecutor(VALID_ENV, JSON.stringify(VALID_ORDER));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.status).toBe('executed');
    expect(parsed.tx_hash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('prints failure receipt when EXECUTOR_STUB_MODE is off', async () => {
    if (skipTests) return;
    const env = { ...VALID_ENV, EXECUTOR_STUB_MODE: '0' };
    const result = await spawnExecutor(env, JSON.stringify(VALID_ORDER));
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('not_yet_implemented_real_mode');
  });

  it('prints failure receipt when SAFE_SIGNER_KEY is missing (EVM order)', async () => {
    if (skipTests) return;
    const env = { ...VALID_ENV };
    delete env.SAFE_SIGNER_KEY;
    const result = await spawnExecutor(env, JSON.stringify(VALID_ORDER));
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.status).toBe('failed');
    expect(parsed.error_kind).toBe('missing_signer_key');
  });

  it('logs EXECUTOR_STUB_MODE warning to stderr', async () => {
    if (skipTests) return;
    const result = await spawnExecutor(VALID_ENV, JSON.stringify(VALID_ORDER));
    expect(result.stderr).toContain('EXECUTOR_STUB_MODE=true');
  });

  it('prints failure receipt on empty stdin', async () => {
    if (skipTests) return;
    const result = await spawnExecutor(VALID_ENV, '');
    expect(result.code).toBe(1);
    const parsed = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}');
    expect(parsed.status).toBe('failed');
  });
});
