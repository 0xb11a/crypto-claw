/**
 * Synthetic-data parity tests for the orders module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-orders output shape is structurally
 * correct. This is the load-bearing parity check during P1a.
 *
 * Shape-only (not byte-identical) — deferred from byte-identical retrofit because:
 *   2. JSON-string parsing: `take_profit_levels` is stored as a JSON text column.
 *      Legacy db-query.js parses it to number[] for buy orders; the API does the
 *      same. However, the API also parses other JSON-string columns (e.g. tp_levels_hit
 *      on the associated position) that the legacy CLI leaves as raw strings, making
 *      byte-identical deepEqual fragile across future schema changes.
 * Full byte-identical retrofit would require building a normalizeForParity()
 * translation layer — deferred indefinitely.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCRIPTS_DIR = resolve(REPO_ROOT, 'scripts');

let tempDir: string;
let legacyDbPath: string;

const PENDING_BUY_ID = 'parity-ord-pending-1';
const PENDING_SELL_ID = 'parity-ord-sell-1';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-ord-'));
  legacyDbPath = resolve(tempDir, 'test.db');

  const baseEnv = {
    ...process.env,
    SAFE_ID: 'test',
    DB_PATH: legacyDbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${legacyDbPath}`,
    // Explicitly disable auto-approve so buy orders stay pending
    AUTO_APPROVE_BUY: 'false',
    AUTO_APPROVE_BUY_MAX_USD: '',
    PAPER_MODE: 'false',
  };

  const run = (cmd: string, args: string[]) =>
    execFileSync('node', [resolve(SCRIPTS_DIR, 'db-query.js'), cmd, ...args], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });

  // Insert a pending buy order
  run('add-order', [
    '--json',
    JSON.stringify({
      id: PENDING_BUY_ID,
      action: 'buy',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      amount: '100',
      tier: 'conviction',
      entry_price: 2000,
      stop_loss: 1600,
      take_profit_levels: [2500, 3000],
      analysis_score: 85,
      risk_score: 20,
    }),
  ]);

  // Insert a pending sell order
  run('add-order', [
    '--json',
    JSON.stringify({
      id: PENDING_SELL_ID,
      action: 'sell',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      amount: 'all',
      reason: 'stop_loss_hit',
    }),
  ]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runDbQuery(command: string, args: string[] = []): unknown {
  const result = execFileSync(
    'node',
    [resolve(SCRIPTS_DIR, 'db-query.js'), command, ...args],
    {
      env: {
        ...process.env,
        SAFE_ID: 'test',
        DB_PATH: legacyDbPath,
        SAFE_SIGNER_KEY: '',
        SQUADS_SIGNER_KEY: '',
        PRISMA_DISABLE_DOTENV: '1',
        DATABASE_URL: `file:${legacyDbPath}`,
        AUTO_APPROVE_BUY: 'false',
        PAPER_MODE: 'false',
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  return JSON.parse(result);
}

describe('orders parity: structural shape', () => {
  it('get-orders returns an array', () => {
    const output = runDbQuery('get-orders');
    expect(Array.isArray(output)).toBe(true);
  });

  it('get-orders --pending returns pending/approved orders (legacy: awaiting execution)', () => {
    // Note: db-query.js get-orders --pending returns status IN ('pending', 'approved')
    // which means "awaiting execution", not just status='pending'.
    const output = runDbQuery('get-orders', ['--pending']) as Array<{ status: string }>;
    expect(Array.isArray(output)).toBe(true);
    for (const order of output) {
      expect(['pending', 'approved']).toContain(order.status);
    }
  });

  it('order rows have expected field names (snake_case)', () => {
    const output = runDbQuery('get-orders', ['--pending']) as Array<Record<string, unknown>>;
    const order = output.find((o) => o['id'] === PENDING_BUY_ID);
    expect(order).toBeDefined();
    expect(order!['action']).toBe('buy');
    expect(order!['status']).toBe('pending');
    expect(typeof order!['entry_price']).toBe('number');
  });

  it('take_profit_levels is parsed as an array for buy orders', () => {
    const output = runDbQuery('get-orders', ['--pending']) as Array<{ id: string; take_profit_levels: unknown }>;
    const order = output.find((o) => o.id === PENDING_BUY_ID);
    expect(order).toBeDefined();
    expect(Array.isArray(order!.take_profit_levels)).toBe(true);
    expect(order!.take_profit_levels).toEqual([2500, 3000]);
  });

  it('take_profit_levels is null for sell orders', () => {
    const output = runDbQuery('get-orders', ['--pending']) as Array<{ id: string; take_profit_levels: unknown }>;
    const order = output.find((o) => o.id === PENDING_SELL_ID);
    expect(order).toBeDefined();
    expect(order!.take_profit_levels).toBeNull();
  });

  it('get-order-history returns an array', () => {
    const output = runDbQuery('get-order-history');
    expect(Array.isArray(output)).toBe(true);
  });
});
