/**
 * Shim-parity tests for smart-money signals (ADR-0020).
 *
 * Covers both ungrouped and grouped (--group-by token --min-wallets 2) modes,
 * and the --tokens-in-positions flag.
 *
 * Signals are inserted directly into SQLite because they are produced by the
 * legacy background loop (activity-wallets-bg.js) — there is no db-query.js
 * insert command for them. This matches how the real producer works.
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

const CHAIN = 'base';
const TOKEN_ADDR = '0xSignalToken001';
const WALLET_1 = '0xSmartWallet001';
const WALLET_2 = '0xSmartWallet002';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-signals-'));
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

  // Initialise the DB by running any db-query command (this triggers auto-migration)
  execFileSync('node', [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-tracked-wallets'], {
    env: baseEnv,
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 10000,
  });

  // Insert signals directly using better-sqlite3 inline script (no insert CLI command exists)
  const insertScript = `
    const Database = require('better-sqlite3');
    const db = new Database(process.env.DB_PATH);
    const now = new Date().toISOString();
    const stmt = db.prepare(\`
      INSERT OR IGNORE INTO smart_money_signals
        (tx_hash, chain, wallet_address, wallet_score, action, token_address, token_symbol, tx_timestamp, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    \`);
    stmt.run('0xtx1', '${CHAIN}', '${WALLET_1}', 85, 'buy', '${TOKEN_ADDR}', 'SIG', now, now);
    stmt.run('0xtx2', '${CHAIN}', '${WALLET_2}', 90, 'buy', '${TOKEN_ADDR}', 'SIG', now, now);
    stmt.run('0xtx3', '${CHAIN}', '${WALLET_1}', 85, 'sell', '${TOKEN_ADDR}', 'SIG', now, now);
    db.close();
  `;

  execFileSync('node', ['--eval', insertScript], {
    env: { ...baseEnv, DB_PATH: legacyDbPath },
    cwd: resolve(REPO_ROOT, 'scripts'),
    encoding: 'utf8',
    timeout: 10000,
  });

  // Seed a position so --tokens-in-positions filter works
  execFileSync(
    'node',
    [
      resolve(SCRIPTS_DIR, 'db-query.js'),
      'add-position',
      '--json',
      JSON.stringify({
        id: 'pos-signal-parity',
        symbol: 'SIG',
        address: TOKEN_ADDR,
        chain: CHAIN,
        tier: 'moonshot',
        entry_price: 0.1,
        quantity: 1000,
        stop_loss: 0.05,
        take_profit_levels: [0.2],
      }),
    ],
    { env: baseEnv, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
  );
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

describe('signals parity: structural shape (ADR-0020)', () => {
  describe('ungrouped mode', () => {
    it('get-smart-money-signals returns an array', () => {
      const output = runDbQuery('get-smart-money-signals', ['--since', '60m']);
      expect(Array.isArray(output)).toBe(true);
    });

    it('signal rows have expected snake_case fields', () => {
      const output = runDbQuery('get-smart-money-signals', ['--since', '60m']) as Array<
        Record<string, unknown>
      >;
      expect(output.length).toBeGreaterThan(0);
      const s = output[0]!;
      expect(typeof s['id']).toBe('number');
      expect(typeof s['tx_hash']).toBe('string');
      expect(typeof s['chain']).toBe('string');
      expect(typeof s['wallet_address']).toBe('string');
      expect(typeof s['action']).toBe('string');
      expect(typeof s['token_address']).toBe('string');
      expect(typeof s['tx_timestamp']).toBe('string');
    });

    it('--action buy filters correctly', () => {
      const output = runDbQuery('get-smart-money-signals', ['--since', '60m', '--action', 'buy']) as Array<
        Record<string, unknown>
      >;
      expect(output.length).toBeGreaterThan(0);
      expect(output.every((s) => s['action'] === 'buy')).toBe(true);
    });

    it('--action sell filters correctly', () => {
      const output = runDbQuery('get-smart-money-signals', ['--since', '60m', '--action', 'sell']) as Array<
        Record<string, unknown>
      >;
      expect(output.length).toBeGreaterThan(0);
      expect(output.every((s) => s['action'] === 'sell')).toBe(true);
    });
  });

  describe('grouped mode (--group-by token)', () => {
    it('returns aggregated rows with n_wallets, signal_count, avg_score', () => {
      const output = runDbQuery('get-smart-money-signals', [
        '--since',
        '60m',
        '--group-by',
        'token',
      ]) as Array<Record<string, unknown>>;
      expect(Array.isArray(output)).toBe(true);
      expect(output.length).toBeGreaterThan(0);
      const row = output.find((r) => r['token_address'] === TOKEN_ADDR);
      expect(row).toBeDefined();
      expect(typeof row!['n_wallets']).toBe('number');
      expect(typeof row!['signal_count']).toBe('number');
      // avg_score may be null if all wallet_scores are null, otherwise number
      expect(row!['avg_score'] === null || typeof row!['avg_score'] === 'number').toBe(true);
    });

    it('--min-wallets 2 returns only tokens with ≥2 distinct wallets', () => {
      const output = runDbQuery('get-smart-money-signals', [
        '--since',
        '60m',
        '--group-by',
        'token',
        '--min-wallets',
        '2',
      ]) as Array<Record<string, unknown>>;
      expect(Array.isArray(output)).toBe(true);
      // TOKEN_ADDR has 2 distinct wallets
      const row = output.find((r) => r['token_address'] === TOKEN_ADDR);
      expect(row).toBeDefined();
      expect(Number(row!['n_wallets'])).toBeGreaterThanOrEqual(2);
    });

    it('grouped row has first_seen and last_seen fields', () => {
      const output = runDbQuery('get-smart-money-signals', [
        '--since',
        '60m',
        '--group-by',
        'token',
      ]) as Array<Record<string, unknown>>;
      const row = output.find((r) => r['token_address'] === TOKEN_ADDR);
      expect(row).toBeDefined();
      expect(typeof row!['first_seen']).toBe('string');
      expect(typeof row!['last_seen']).toBe('string');
    });
  });

  describe('--tokens-in-positions flag', () => {
    it('returns signals only for tokens in open positions', () => {
      const output = runDbQuery('get-smart-money-signals', [
        '--since',
        '60m',
        '--tokens-in-positions',
      ]) as Array<Record<string, unknown>>;
      expect(Array.isArray(output)).toBe(true);
      // TOKEN_ADDR is in positions; all returned signals should be for that token
      expect(output.length).toBeGreaterThan(0);
      expect(output.every((s) => s['token_address'] === TOKEN_ADDR)).toBe(true);
    });
  });
});
