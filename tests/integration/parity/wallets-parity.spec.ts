/**
 * Shim-parity tests for the wallets module (ADR-0020).
 *
 * Verifies that the legacy db-query.js tracked-wallet commands produce the
 * same field shapes as the new @cclaw/wallets module.
 *
 * Scope: get-tracked-wallets, add-tracked-wallet, propose-wallet,
 *        get-unscored-wallets, update-wallet-score, remove-tracked-wallet.
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

const SCORED_WALLET_ADDR = '0xScoredWallet001';
const PROPOSED_WALLET_ADDR = '0xProposedWallet001';
const CHAIN = 'base';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-wallets-'));
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

  // Add a fully scored wallet (INSERT OR REPLACE)
  run('add-tracked-wallet', [
    '--json',
    JSON.stringify({
      address: SCORED_WALLET_ADDR,
      chain: CHAIN,
      label: 'Test Smart Money',
      type: 'smart_money',
      score: 85,
      score_breakdown: '{"birdeye":80,"zerion":90}',
    }),
  ]);

  // Propose a wallet (INSERT OR IGNORE)
  run('propose-wallet', [
    '--json',
    JSON.stringify({
      address: PROPOSED_WALLET_ADDR,
      chain: CHAIN,
      source_token: '0xSourceToken',
      source: 'agent',
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

describe('wallets parity: structural shape (ADR-0020)', () => {
  it('get-tracked-wallets returns an array', () => {
    const output = runDbQuery('get-tracked-wallets');
    expect(Array.isArray(output)).toBe(true);
  });

  it('scored wallet has expected snake_case fields', () => {
    const output = runDbQuery('get-tracked-wallets') as Array<Record<string, unknown>>;
    const w = output.find((r) => r['address'] === SCORED_WALLET_ADDR);
    expect(w).toBeDefined();
    expect(w!['chain']).toBe(CHAIN);
    expect(w!['type']).toBe('smart_money');
    expect(typeof w!['score']).toBe('number');
    expect(w!['status']).toBe('scored');
    expect(w!['retry_count']).toBe(0);
  });

  it('score_breakdown is a raw JSON string (not parsed)', () => {
    const output = runDbQuery('get-tracked-wallets') as Array<Record<string, unknown>>;
    const w = output.find((r) => r['address'] === SCORED_WALLET_ADDR);
    expect(w).toBeDefined();
    // db-query.js returns score_breakdown as TEXT from SQLite — it should be a string
    expect(typeof w!['score_breakdown']).toBe('string');
  });

  it('proposed wallet has status=proposed and retry_count=0', () => {
    const output = runDbQuery('get-tracked-wallets', ['--status', 'proposed']) as Array<
      Record<string, unknown>
    >;
    const w = output.find((r) => r['address'] === PROPOSED_WALLET_ADDR);
    expect(w).toBeDefined();
    expect(w!['status']).toBe('proposed');
    expect(w!['retry_count']).toBe(0);
  });

  it('get-unscored-wallets returns the proposed wallet', () => {
    const output = runDbQuery('get-unscored-wallets') as Array<Record<string, unknown>>;
    expect(Array.isArray(output)).toBe(true);
    const w = output.find((r) => r['address'] === PROPOSED_WALLET_ADDR);
    expect(w).toBeDefined();
  });

  it('update-wallet-score marks wallet as scored', () => {
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
        'update-wallet-score',
        '--address',
        PROPOSED_WALLET_ADDR,
        '--chain',
        CHAIN,
        '--json',
        JSON.stringify({ score: 75, type: 'whale', status: 'scored' }),
      ],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    const output = runDbQuery('get-tracked-wallets', ['--status', 'scored']) as Array<
      Record<string, unknown>
    >;
    const w = output.find((r) => r['address'] === PROPOSED_WALLET_ADDR);
    expect(w).toBeDefined();
    expect(w!['status']).toBe('scored');
    expect(w!['type']).toBe('whale');
  });

  it('remove-tracked-wallet deletes the entry', () => {
    const TEMP_ADDR = '0xTempWalletRemove';
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
        'propose-wallet',
        '--json',
        JSON.stringify({ address: TEMP_ADDR, chain: CHAIN }),
      ],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    execFileSync(
      'node',
      [
        resolve(SCRIPTS_DIR, 'db-query.js'),
        'remove-tracked-wallet',
        '--address',
        TEMP_ADDR,
        '--chain',
        CHAIN,
      ],
      { env, cwd: REPO_ROOT, encoding: 'utf8', timeout: 10000 },
    );

    const output = runDbQuery('get-tracked-wallets') as Array<Record<string, unknown>>;
    const w = output.find((r) => r['address'] === TEMP_ADDR);
    expect(w).toBeUndefined();
  });
});
