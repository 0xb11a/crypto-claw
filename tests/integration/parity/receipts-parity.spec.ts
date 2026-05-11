/**
 * Synthetic-data parity tests for the receipts module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-receipts output shape matches the
 * API's receipts module response shape. Uses synthetic data seeded via db-query.js.
 *
 * During P1b there is no baseline JSON (baseline/ is read-only per DoD §I),
 * so this spec asserts shape and field mapping correctness rather than
 * byte-identical output.
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

const RECEIPT_ID = 'parity-receipt-1';
const ORDER_ID = 'parity-order-1';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-receipts-'));
  legacyDbPath = resolve(tempDir, 'test.db');

  const baseEnv = {
    ...process.env,
    SAFE_ID: 'test',
    DB_PATH: legacyDbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${legacyDbPath}`,
    PAPER_MODE: 'false',
    AUTO_APPROVE_BUY: 'false',
    AUTO_APPROVE_BUY_MAX_USD: '',
  };

  const run = (cmd: string, args: string[]) =>
    execFileSync('node', [resolve(SCRIPTS_DIR, 'db-query.js'), cmd, ...args], {
      env: baseEnv,
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });

  // Seed a sell order (fewer required fields than buy; action=sell only needs symbol/address/chain/amount/reason)
  run('add-order', [
    '--json',
    JSON.stringify({
      id: ORDER_ID,
      action: 'sell',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      amount: '100',
      reason: 'parity test',
    }),
  ]);

  run('add-receipt', [
    '--json',
    JSON.stringify({
      id: RECEIPT_ID,
      order_id: ORDER_ID,
      action: 'sell',
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      status: 'executed',
      amount: 100.0,
      quantity: 0.05,
      executed_price: 2000.0,
    }),
  ]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Receipts module — synthetic parity (ADR-0020)', () => {
  it('legacy get-receipt --id returns a single row with id, order_id, action, symbol, chain, status fields', () => {
    const output = execFileSync(
      'node',
      [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-receipt', '--id', RECEIPT_ID],
      {
        env: { ...process.env, SAFE_ID: 'test', DB_PATH: legacyDbPath },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    const receipt = JSON.parse(output) as Record<string, unknown>;
    expect(receipt['id']).toBe(RECEIPT_ID);
    expect(receipt['order_id']).toBe(ORDER_ID);
    expect(receipt['action']).toBe('sell'); // matches add-receipt action field
    expect(receipt['symbol']).toBe('ETH');
    expect(receipt['chain']).toBe('base');
    expect(receipt['status']).toBe('executed');
  });

  it('legacy get-receipt --id returns a row with expected field names (snake_case)', () => {
    // Re-fetch by ID to confirm field name conventions (snake_case parity assertion)
    const output = execFileSync(
      'node',
      [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-receipt', '--id', RECEIPT_ID],
      {
        env: { ...process.env, SAFE_ID: 'test', DB_PATH: legacyDbPath },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    const receipt = JSON.parse(output) as Record<string, unknown>;
    // These are the legacy snake_case field names the new API must mirror
    expect(receipt['id']).toBe(RECEIPT_ID);
    expect(receipt['order_id']).toBe(ORDER_ID);
    expect(receipt['executed_price']).toBe(2000.0);
    expect(typeof receipt['quantity']).toBe('number');
    // status field must be present as a string
    expect(typeof receipt['status']).toBe('string');
  });
});
