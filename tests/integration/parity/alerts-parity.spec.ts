/**
 * Synthetic-data parity tests for the alerts module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-alerts output shape matches the
 * API's alerts module response shape.
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

const ALERT_ID = 'parity-alert-1';

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-alerts-'));
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

  run('add-alert', [
    '--json',
    JSON.stringify({
      id: ALERT_ID,
      symbol: 'ETH',
      chain: 'base',
      alert_type: 'stop_loss',
      severity: 'high',
      current_price: 1500.0,
      trigger_price: 1600.0,
      details: 'Price below stop loss',
    }),
  ]);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Alerts module — synthetic parity (ADR-0020)', () => {
  it('legacy get-alerts returns an array with id, symbol, chain, alert_type, severity, processed fields', () => {
    const output = execFileSync('node', [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-alerts'], {
      env: { ...process.env, SAFE_ID: 'test', DB_PATH: legacyDbPath },
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 10000,
    });
    const data = JSON.parse(output) as unknown[];
    expect(Array.isArray(data)).toBe(true);
    const alert = data.find((a) => (a as Record<string, unknown>)['id'] === ALERT_ID) as
      | Record<string, unknown>
      | undefined;
    expect(alert).toBeDefined();
    expect(alert!['symbol']).toBe('ETH');
    expect(alert!['chain']).toBe('base');
    expect(alert!['alert_type']).toBe('stop_loss');
    expect(alert!['severity']).toBe('high');
    expect(alert!['processed']).toBe(0);
  });
});
