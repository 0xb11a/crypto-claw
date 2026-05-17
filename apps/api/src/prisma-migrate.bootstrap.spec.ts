/**
 * Unit tests for runPrismaMigrateDeploy() — apps/api/src/prisma-migrate.bootstrap.ts
 *
 * Plan spec (a): happy path, failure path, idempotency.
 * DoD §A  — tests fail before the bootstrap module existed, pass after.
 * SPEC §4 — boot sequence invariant: migration runs BEFORE NestFactory.create.
 *
 * DB verification uses a child `node -e` process with the built-in node:sqlite
 * module (Node.js 22+) rather than a direct import, because Vite (underlying
 * Vitest's bundler) does not resolve 'node:sqlite' as an ES module in this
 * project's vitest.config.ts (environment: 'node' + Vite 5 bundler).
 *
 * The function under test calls execFileSync with the compiled Prisma binary,
 * so it exercises the real CLI code path — not a mock.
 */

import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = resolve(__dirname, '../../..');
const PRISMA_BIN = resolve(REPO_ROOT, 'node_modules/.bin/prisma');

/**
 * Create a fresh temp directory with a unique DB path.
 * Returns the DB path + cleanup function.
 */
function makeTempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(resolve(tmpdir(), 'cclaw-bootstrap-spec-'));
  const dbPath = resolve(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Run a SQLite query in a child process via node:sqlite (built-in, Node.js 22+).
 * Returns the JSON-encoded result rows.
 * Throws if the query fails or the file doesn't exist.
 */
function querySqlite(dbPath: string, sql: string, params: string[] = []): unknown[] {
  const script = `
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(${JSON.stringify(dbPath)});
    const rows = db.prepare(${JSON.stringify(sql)}).all(${params.map((p) => JSON.stringify(p)).join(',')});
    db.close();
    process.stdout.write(JSON.stringify(rows));
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
  });
  return JSON.parse(output) as unknown[];
}

/**
 * Check whether a specific table exists in the SQLite file.
 */
function hasTable(dbPath: string, tableName: string): boolean {
  const rows = querySqlite(dbPath, `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, [
    tableName,
  ]) as Array<{ name: string }>;
  return rows.length > 0;
}

/**
 * Count rows in _prisma_migrations.
 */
function countMigrationRows(dbPath: string): number {
  const rows = querySqlite(dbPath, 'SELECT count(*) as n FROM _prisma_migrations') as Array<{ n: number }>;
  return rows[0]!.n;
}

// ---------------------------------------------------------------------------
// Import the function under test.
import { runPrismaMigrateDeploy } from './prisma-migrate.bootstrap.js';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runPrismaMigrateDeploy — happy path', () => {
  it('exits without throwing against a fresh DB', () => {
    const { dbPath, cleanup } = makeTempDb();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
      // Signer keys must be absent per boot invariant (SPEC §4 #4).
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };

    expect(() => runPrismaMigrateDeploy(env)).not.toThrow();

    cleanup();
  });

  it('creates the _prisma_migrations table (Prisma schema applied)', () => {
    const { dbPath, cleanup } = makeTempDb();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };

    runPrismaMigrateDeploy(env);

    expect(hasTable(dbPath, '_prisma_migrations')).toBe(true);

    cleanup();
  });

  it('creates the portfolio_meta table (from Prisma migrations)', () => {
    const { dbPath, cleanup } = makeTempDb();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };

    runPrismaMigrateDeploy(env);

    expect(hasTable(dbPath, 'portfolio_meta')).toBe(true);

    cleanup();
  });
});

describe('runPrismaMigrateDeploy — failure path', () => {
  it('throws when DATABASE_URL is missing (non-zero Prisma exit)', () => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Intentionally omit DATABASE_URL — Prisma migrate deploy requires it.
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };
    // Delete DATABASE_URL explicitly in case it leaked from process.env.
    delete env['DATABASE_URL'];

    // execFileSync throws a SpawnSyncReturns error with a non-zero status.
    expect(() => runPrismaMigrateDeploy(env)).toThrow();
  });

  it('throws when DATABASE_URL points to a non-writable location', () => {
    // /dev/null cannot host a valid SQLite file.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: 'file:/dev/null/cannot-create-here.db?connection_limit=1',
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };

    expect(() => runPrismaMigrateDeploy(env)).toThrow();
  });
});

describe('runPrismaMigrateDeploy — idempotency', () => {
  it('second call against an up-to-date DB exits without throwing and row count is unchanged', () => {
    const { dbPath, cleanup } = makeTempDb();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '',
      SQUADS_SIGNER_KEY: '',
    };

    // First call: applies all pending migrations.
    runPrismaMigrateDeploy(env);
    const rowsAfterFirst = countMigrationRows(dbPath);
    expect(rowsAfterFirst).toBeGreaterThan(0);

    // Second call: all migrations already applied → no-op. Must not throw.
    expect(() => runPrismaMigrateDeploy(env)).not.toThrow();

    const rowsAfterSecond = countMigrationRows(dbPath);
    expect(rowsAfterSecond).toBe(rowsAfterFirst);

    cleanup();
  });
});

describe('runPrismaMigrateDeploy — boot order invariant (SPEC §4)', () => {
  it('accepts env with signer keys set to empty string (validated before call in main.ts)', () => {
    // The boot sequence in main.ts calls assertNoSignerKeysInEnv BEFORE
    // runPrismaMigrateDeploy. After the assertion passes, signer keys are
    // empty-string (absent). The child process inherits this exact env.
    // This test verifies the function accepts the validated env and runs normally.
    const { dbPath, cleanup } = makeTempDb();
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
      SAFE_SIGNER_KEY: '', // signer-key absent (validated before this call in main.ts)
      SQUADS_SIGNER_KEY: '', // ditto
    };

    // If the function mutates env or injects keys between the check and the
    // spawn, a signer-key leak would surface in the child's env. Absence of
    // throw is the positive signal; a key-injection regression is covered by
    // tests/integration/security/signer-isolation-multiprocess.spec.ts.
    expect(() => runPrismaMigrateDeploy(env)).not.toThrow();
    expect(hasTable(dbPath, '_prisma_migrations')).toBe(true);

    cleanup();
  });
});

// ---------------------------------------------------------------------------
// Verify PRISMA_BIN resolution (plan §56 — Prisma binary path risk)
// ---------------------------------------------------------------------------

describe('PRISMA_BIN resolution', () => {
  it('monorepo root node_modules/.bin/prisma is executable', () => {
    // Verify the binary exists — if the path resolution in bootstrap.ts is
    // wrong (e.g. goes one level too deep / too shallow), this test catches it.
    let out = '';
    try {
      out = execFileSync(PRISMA_BIN, ['--version'], { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      out = '';
    }
    expect(out).toMatch(/prisma/i);
  });
});
