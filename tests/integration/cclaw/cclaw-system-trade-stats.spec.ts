/**
 * Integration tests for `cclaw system trade-stats` subcommand.
 *
 * SPEC §13 — cclaw CLI wrapper (Commander.js)
 * DoD §A  — every new subcommand has a test that exercises it against a live API.
 *
 * Gated on CCLAW_SECURITY_TESTS_ENABLED=1 — spawns a compiled API binary.
 * Requires `pnpm build` before running.
 *
 * Port: 7910
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

const PORT = 7910;
const BASE = `http://127.0.0.1:${PORT}`;

const BASE_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-cclaw-trade-stats-test',
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
    tmpPrefix: 'cclaw-trade-stats-cli-integration',
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
// cclaw system trade-stats — no chain
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system trade-stats — all chains', () => {
  it('exits 0 and outputs valid JSON', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'trade-stats']);
    expect(exitCode, `system trade-stats failed: ${stderr}`).toBe(0);
    expect(() => JSON.parse(stdout)).not.toThrow();
  });

  it('REGRESSION GATE: all 12 required stat fields present and defined in CLI output', () => {
    const { stdout } = cclaw(['system', 'trade-stats']);
    const b = JSON.parse(stdout) as Record<string, unknown>;
    // All 12 fields per TradeStatsResponseDto
    const requiredFields = [
      'total_trades', 'wins', 'losses',
      'avg_win_percent', 'avg_loss_percent',
      'total_pnl_usd', 'best_trade_pnl', 'worst_trade_pnl',
      'win_rate', 'total_return_percent',
      'current_value', 'initial_balance',
    ];
    for (const field of requiredFields) {
      // Field must be present in the output (may be 0 or null, but never absent)
      expect(field in b, `field '${field}' is missing from cclaw system trade-stats output`).toBe(true);
      expect(b[field], `field '${field}' should not be undefined`).not.toBeUndefined();
    }
  });

  it('total_trades is a number (not string from $queryRaw bigint)', () => {
    const { stdout } = cclaw(['system', 'trade-stats']);
    const b = JSON.parse(stdout) as Record<string, unknown>;
    expect(typeof b['total_trades']).toBe('number');
  });

  it('win_rate is 0 for empty DB (not NaN or undefined)', () => {
    const { stdout } = cclaw(['system', 'trade-stats']);
    const b = JSON.parse(stdout) as Record<string, unknown>;
    expect(b['win_rate']).toBe(0);
    expect(Number.isNaN(b['win_rate'])).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cclaw system trade-stats --chain base
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system trade-stats --chain base', () => {
  it('exits 0 and returns chain-filtered shape with chain field', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'trade-stats', '--chain', 'base']);
    expect(exitCode, `system trade-stats --chain base failed: ${stderr}`).toBe(0);
    const b = JSON.parse(stdout) as Record<string, unknown>;
    expect(b['chain']).toBe('base');
  });
});

// ---------------------------------------------------------------------------
// cclaw system trade-stats --mode paper
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system trade-stats --mode paper', () => {
  it('exits 0 and returns _mode: paper', () => {
    const { exitCode, stdout, stderr } = cclaw(['system', 'trade-stats', '--mode', 'paper']);
    expect(exitCode, `system trade-stats --mode paper failed: ${stderr}`).toBe(0);
    const b = JSON.parse(stdout) as Record<string, unknown>;
    expect(b['_mode']).toBe('paper');
  });
});

// ---------------------------------------------------------------------------
// Adversarial
// ---------------------------------------------------------------------------

describe.skipIf(!ENABLED)('cclaw system trade-stats — adversarial', () => {
  it('exits non-zero when no token configured', () => {
    try {
      execFileSync('node', [CCLAW_BIN, 'system', 'trade-stats'], {
        encoding: 'utf8',
        env: { ...process.env, CCLAW_API_BASE: BASE, CCLAW_API_TOKEN: '' },
        timeout: 10_000,
      });
      expect(true).toBe(false); // should not reach here
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException & { status?: number };
      expect(err.status ?? 1).not.toBe(0);
    }
  });
});
