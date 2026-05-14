/**
 * Synthetic-data parity tests for the positions module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-positions output shape is structurally
 * correct. This is the load-bearing parity check during P1a.
 *
 * Shape-only (not byte-identical) — deferred from byte-identical retrofit because:
 *   1. mode discriminator: API adds `mode: 'real' | 'paper'` to every position row;
 *      legacy CLI has no such field.
 *   2. JSON-string parsing: `take_profit_levels` is stored as a JSON text column.
 *      Both legacy and API parse it to number[], so this field does match — but
 *      `tp_levels_hit` is intentionally left as a raw JSON string on both sides
 *      (see fix(positions) commit). Any future decision to parse tp_levels_hit on
 *      the API side would break byte-identical parity.
 * Full byte-identical retrofit would require either reverting the mode discriminator
 * design win or building a normalizeForParity() translation layer — deferred indefinitely.
 *
 * Field asymmetry (intentionally preserved for legacy parity):
 * - take_profit_levels: parsed to number[] by both db-query.js and PositionsRepository
 * - tp_levels_hit: returned as a raw JSON string by both db-query.js and PositionsRepository
 *   (this was a regression in P1a that was fixed in the second-pass; see fix(positions) commit)
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

const OPEN_POS_ID = 'parity-open-1';
const CLOSED_POS_ID = 'parity-closed-1';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-pos-'));
  legacyDbPath = resolve(tempDir, 'test.db');

  const baseEnv = {
    ...process.env,
    SAFE_ID: 'test',
    DB_PATH: legacyDbPath,
    SAFE_SIGNER_KEY: '',
    SQUADS_SIGNER_KEY: '',
    PRISMA_DISABLE_DOTENV: '1',
    DATABASE_URL: `file:${legacyDbPath}`,
    // Explicitly disable paper mode and auto-approve to ensure deterministic behavior
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

  run('add-position', [
    '--json',
    JSON.stringify({
      id: OPEN_POS_ID,
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      tier: 'conviction',
      entry_price: 2000,
      quantity: 0.5,
      stop_loss: 1600,
      take_profit_levels: [2500, 3000, 4000],
    }),
  ]);

  run('add-position', [
    '--json',
    JSON.stringify({
      id: CLOSED_POS_ID,
      symbol: 'SOL',
      address: 'So11111111111111111111111111111111111111112',
      chain: 'solana',
      tier: 'moonshot',
      entry_price: 100,
      quantity: 2,
      stop_loss: 80,
      take_profit_levels: [120, 140],
      status: 'closed',
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
        PAPER_MODE: 'false',
        AUTO_APPROVE_BUY: 'false',
        AUTO_APPROVE_BUY_MAX_USD: '',
      },
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    },
  );
  return JSON.parse(result);
}

describe('positions parity: structural shape', () => {
  it('get-positions (default: open) returns an array', () => {
    const output = runDbQuery('get-positions');
    expect(Array.isArray(output)).toBe(true);
  });

  it('get-positions --status open returns the open position', () => {
    const output = runDbQuery('get-positions', ['--status', 'open']) as Array<{ id: string; status: string }>;
    const pos = output.find((p) => p.id === OPEN_POS_ID);
    expect(pos).toBeDefined();
    expect(pos!.status).toBe('open');
  });

  it('get-positions --status closed returns the closed position', () => {
    const output = runDbQuery('get-positions', ['--status', 'closed']) as Array<{ id: string; status: string }>;
    const pos = output.find((p) => p.id === CLOSED_POS_ID);
    expect(pos).toBeDefined();
    expect(pos!.status).toBe('closed');
  });

  it('position rows have expected field names (snake_case)', () => {
    const output = runDbQuery('get-positions', ['--status', 'open']) as Array<Record<string, unknown>>;
    const pos = output.find((p) => p['id'] === OPEN_POS_ID);
    expect(pos).toBeDefined();
    expect(typeof pos!['entry_price']).toBe('number');
    expect(typeof pos!['stop_loss']).toBe('number');
    expect(pos!['status']).toBe('open');
  });

  it('take_profit_levels is parsed as an array by db-query.js', () => {
    const output = runDbQuery('get-positions', ['--status', 'open']) as Array<{ id: string; take_profit_levels: unknown }>;
    const pos = output.find((p) => p.id === OPEN_POS_ID);
    expect(pos).toBeDefined();
    expect(Array.isArray(pos!.take_profit_levels)).toBe(true);
    expect(pos!.take_profit_levels).toEqual([2500, 3000, 4000]);
  });

  it('tp_levels_hit is a raw JSON string in db-query.js output (matches PositionsRepository)', () => {
    // db-query.js parses take_profit_levels but NOT tp_levels_hit.
    // PositionsRepository now matches this behavior: tp_levels_hit is returned as the
    // raw TEXT column value (e.g. '[]'), NOT as a parsed array.
    // This was fixed in the second-pass commit fix(positions): preserve tp_levels_hit as raw string.
    const output = runDbQuery('get-positions', ['--status', 'open']) as Array<{ id: string; tp_levels_hit: unknown }>;
    const pos = output.find((p) => p.id === OPEN_POS_ID);
    expect(pos).toBeDefined();
    // Both legacy and new API return the raw string
    expect(typeof pos!.tp_levels_hit).toBe('string');
  });

  it('get-positions --status all returns both open and closed positions', () => {
    const output = runDbQuery('get-positions', ['--status', 'all']) as Array<{ id: string }>;
    expect(Array.isArray(output)).toBe(true);
    expect(output.some((p) => p.id === OPEN_POS_ID)).toBe(true);
    expect(output.some((p) => p.id === CLOSED_POS_ID)).toBe(true);
  });
});
