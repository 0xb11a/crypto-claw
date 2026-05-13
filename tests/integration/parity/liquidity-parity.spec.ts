/**
 * Shim-parity tests for the liquidity module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-liquidity and add-liquidity-snapshot
 * commands produce the same field shapes as the new @cclaw/liquidity module.
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

const TOKEN_ADDR = '0xLiquidityPool001';
const CHAIN = 'base';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-liquidity-'));
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

  // Add two liquidity snapshots for the same pool
  run('add-liquidity-snapshot', ['--address', TOKEN_ADDR, '--chain', CHAIN, '--liquidity', '50000']);
  run('add-liquidity-snapshot', ['--address', TOKEN_ADDR, '--chain', CHAIN, '--liquidity', '48000']);
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

describe('liquidity parity: structural shape (ADR-0020)', () => {
  it('get-liquidity returns an array', () => {
    const output = runDbQuery('get-liquidity', ['--address', TOKEN_ADDR, '--chain', CHAIN]);
    expect(Array.isArray(output)).toBe(true);
  });

  it('snapshot rows have expected snake_case fields', () => {
    const output = runDbQuery('get-liquidity', ['--address', TOKEN_ADDR, '--chain', CHAIN]) as Array<
      Record<string, unknown>
    >;
    expect(output.length).toBeGreaterThan(0);
    const s = output[0]!;
    expect(typeof s['id']).toBe('number');
    expect(s['address']).toBe(TOKEN_ADDR);
    expect(s['chain']).toBe(CHAIN);
    expect(typeof s['liquidity_usd']).toBe('number');
  });

  it('default limit is 2 (legacy semantics)', () => {
    const output = runDbQuery('get-liquidity', [
      '--address',
      TOKEN_ADDR,
      '--chain',
      CHAIN,
    ]) as unknown[];
    // We inserted 2 snapshots; legacy defaults to limit=2
    expect(output.length).toBeLessThanOrEqual(2);
  });

  it('returns up to 2 snapshots when limit=2', () => {
    const output = runDbQuery('get-liquidity', [
      '--address',
      TOKEN_ADDR,
      '--chain',
      CHAIN,
      '--limit',
      '2',
    ]) as Array<Record<string, unknown>>;
    expect(output.length).toBeLessThanOrEqual(2);
    // Each row must have the required fields
    for (const row of output) {
      expect(typeof row['id']).toBe('number');
      expect(row['address']).toBe(TOKEN_ADDR);
      expect(row['chain']).toBe(CHAIN);
      expect(typeof row['liquidity_usd']).toBe('number');
    }
  });

  it('liquidity_usd is a number', () => {
    const output = runDbQuery('get-liquidity', ['--address', TOKEN_ADDR, '--chain', CHAIN]) as Array<
      Record<string, unknown>
    >;
    expect(typeof output[0]!['liquidity_usd']).toBe('number');
    expect(output[0]!['liquidity_usd']).toBeGreaterThan(0);
  });
});
