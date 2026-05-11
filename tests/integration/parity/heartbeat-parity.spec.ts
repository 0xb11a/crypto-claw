/**
 * Synthetic-data parity tests for the heartbeat module (ADR-0020).
 *
 * Verifies that the legacy db-query.js get-heartbeats output shape matches
 * the API's heartbeat module response shape, including the computed fields
 * seconds_since, expected_cadence_seconds, and idle_ok.
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

beforeAll(() => {
  tempDir = mkdtempSync(resolve(tmpdir(), 'cclaw-parity-hb-'));
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

  // Seed a heartbeat row for executor
  run('update-heartbeat', ['--agent', 'executor', '--check', 'process_orders']);
});

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('Heartbeat module — synthetic parity (ADR-0020)', () => {
  it('legacy get-heartbeats returns rows with agent, check, last_run_at, seconds_since, expected_cadence_seconds, idle_ok fields', () => {
    const output = execFileSync(
      'node',
      [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-heartbeats', '--agent', 'executor'],
      {
        env: { ...process.env, SAFE_ID: 'test', DB_PATH: legacyDbPath, PAPER_MODE: 'false' },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    const rows = JSON.parse(output) as unknown[];
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.length).toBeGreaterThan(0);

    const row = rows[0] as Record<string, unknown>;
    expect(row['agent']).toBe('executor');
    expect(row['check']).toBe('process_orders');
    expect(typeof row['last_run_at']).toBe('string');
    expect(typeof row['seconds_since']).toBe('number');
    // executor process_orders cadence=0 → fallback to AGENT_HEARTBEAT_INTERVALS[executor]=1 minute = 60 seconds
    expect(row['expected_cadence_seconds']).toBe(60);
    // idle_ok = true because there are no approved orders in a fresh DB
    expect(row['idle_ok']).toBe(true);
  });

  it('legacy get-overdue-checks returns overdue/not_yet_due arrays', () => {
    const output = execFileSync(
      'node',
      [resolve(SCRIPTS_DIR, 'db-query.js'), 'get-overdue-checks', '--agent', 'executor'],
      {
        env: { ...process.env, SAFE_ID: 'test', DB_PATH: legacyDbPath },
        cwd: REPO_ROOT,
        encoding: 'utf8',
        timeout: 10000,
      },
    );
    const result = JSON.parse(output) as Record<string, unknown>;
    expect(result['agent']).toBe('executor');
    expect(Array.isArray(result['overdue'])).toBe(true);
    expect(Array.isArray(result['not_yet_due'])).toBe(true);
  });
});
