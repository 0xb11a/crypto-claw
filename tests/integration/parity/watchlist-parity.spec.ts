/**
 * Shim-parity tests for the watchlist module (ADR-0020).
 *
 * Verifies that the legacy db-query.js watchlist commands produce the same
 * field shapes as the new @cclaw/watchlist module.
 *
 * Scope: get-watchlist, add-to-watchlist, update-watchlist, remove-from-watchlist.
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

const ENTRY_ID = 'watch-parity-1';
const ENTRY_2_ID = 'watch-parity-2';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-watchlist-'));
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

  run('add-to-watchlist', [
    '--json',
    JSON.stringify({
      id: ENTRY_ID,
      symbol: 'ETH',
      address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
      chain: 'base',
      target_entry: 2000.0,
      current_price: 2100.0,
      analysis_score: 80,
      risk_score: 20,
      reason: 'Strong fundamentals',
    }),
  ]);

  run('add-to-watchlist', [
    '--json',
    JSON.stringify({
      id: ENTRY_2_ID,
      symbol: 'BTC',
      address: '0xBTC',
      chain: 'base',
    }),
  ]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function runDbQuery(command: string, args: string[] = []): unknown {
  const result = execFileSync('node', [resolve(SCRIPTS_DIR, 'db-query.js'), command, ...args], {
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
  });
  return JSON.parse(result);
}

describe('watchlist parity: structural shape (ADR-0020)', () => {
  it('get-watchlist returns an array', () => {
    const output = runDbQuery('get-watchlist');
    expect(Array.isArray(output)).toBe(true);
  });

  it('watchlist entry has expected snake_case fields', () => {
    const output = runDbQuery('get-watchlist') as Array<Record<string, unknown>>;
    const entry = output.find((e) => e['id'] === ENTRY_ID);
    expect(entry).toBeDefined();
    expect(entry!['symbol']).toBe('ETH');
    expect(entry!['chain']).toBe('base');
    expect(typeof entry!['target_entry']).toBe('number');
    expect(typeof entry!['current_price']).toBe('number');
    expect(typeof entry!['analysis_score']).toBe('number');
    expect(entry!['status']).toBe('watching');
  });

  it('status defaults to watching on creation', () => {
    const output = runDbQuery('get-watchlist') as Array<Record<string, unknown>>;
    const entry2 = output.find((e) => e['id'] === ENTRY_2_ID);
    expect(entry2).toBeDefined();
    expect(entry2!['status']).toBe('watching');
  });

  it('get-watchlist --active returns only watching entries', () => {
    const output = runDbQuery('get-watchlist', ['--active']) as Array<Record<string, unknown>>;
    expect(Array.isArray(output)).toBe(true);
    expect(output.every((e) => e['status'] === 'watching')).toBe(true);
  });

  it('update-watchlist updates the entry', () => {
    const env = {
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

    execFileSync(
      'node',
      [
        resolve(SCRIPTS_DIR, 'db-query.js'),
        'update-watchlist',
        '--id',
        ENTRY_ID,
        '--json',
        JSON.stringify({ current_price: 2200.0 }),
      ],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    const output = runDbQuery('get-watchlist') as Array<Record<string, unknown>>;
    const entry = output.find((e) => e['id'] === ENTRY_ID);
    expect(entry).toBeDefined();
    expect(entry!['current_price']).toBe(2200.0);
  });

  it('remove-from-watchlist sets status=removed (soft delete)', () => {
    const REMOVE_ID = 'watch-parity-remove';
    const env = {
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

    execFileSync(
      'node',
      [
        resolve(SCRIPTS_DIR, 'db-query.js'),
        'add-to-watchlist',
        '--json',
        JSON.stringify({ id: REMOVE_ID, symbol: 'SOL', address: '0xSOL', chain: 'base' }),
      ],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    execFileSync(
      'node',
      [resolve(SCRIPTS_DIR, 'db-query.js'), 'remove-from-watchlist', '--id', REMOVE_ID],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    // get-watchlist without --active returns ALL rows including removed
    const all = runDbQuery('get-watchlist') as Array<Record<string, unknown>>;
    const removed = all.find((e) => e['id'] === REMOVE_ID);
    expect(removed).toBeDefined();
    expect(removed!['status']).toBe('removed');

    // --active filter should NOT include the removed entry
    const active = runDbQuery('get-watchlist', ['--active']) as Array<Record<string, unknown>>;
    const removedInActive = active.find((e) => e['id'] === REMOVE_ID);
    expect(removedInActive).toBeUndefined();
  });
});
