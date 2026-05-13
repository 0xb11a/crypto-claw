/**
 * _spawn-api.ts — Reusable helper for integration tests that need a live API process.
 *
 * Extracts the "spawn API, wait for ready, kill on teardown" pattern that
 * was duplicated across four spec files (auth.spec.ts, execute-route.spec.ts,
 * idempotency.spec.ts, paper-mode.spec.ts).  Callers replace their
 * beforeAll/afterAll lifecycle blocks with two lines:
 *
 *   let api: Awaited<ReturnType<typeof startApi>>;
 *   beforeAll(async () => { api = await startApi({ dbPath, env: BASE_ENV }); }, 20_000);
 *   afterAll(async () => api.kill());
 *
 * The helper:
 *   1. Creates a temp dir (if dbPath is empty string / not provided).
 *   2. Runs `pnpm prisma migrate deploy` against the fresh DB.
 *   3. Spawns `node apps/api/dist/main.js` and waits for the "api ready on" log line.
 *   4. Returns { url, port, kill, dbPath } — callers build request URLs from `url`.
 *
 * Port defaults to 7878 (API bind default).  Pass `port` for parallel-spec
 * scenarios where multiple API instances must co-exist (PR-B will use this).
 *
 * SPEC §14 — integration tests spawn the compiled binary.
 * DoD §A  — centralised helper; duplication removed from all callers.
 */

import { spawn, execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';

/** Absolute path to the monorepo root. */
export const REPO_ROOT = resolve(__dirname, '../..');
/** Compiled API entry point (requires prior `pnpm build`). */
const API_DIST = resolve(REPO_ROOT, 'apps/api/dist/main.js');
/** Prisma CLI binary (resolved from root node_modules). */
const PRISMA_BIN = resolve(REPO_ROOT, 'node_modules/.bin/prisma');

/**
 * Options for startApi().
 */
export interface StartApiOpts {
  /**
   * Absolute path to the SQLite database file.
   * If empty string, startApi creates a temporary directory and sets
   * dbPath = `<tmpdir>/<prefix>-test.db`.
   */
  dbPath: string;

  /**
   * Extra environment variables merged into the child env on top of
   * `{ PATH, NODE_PATH }` from the parent process.
   * Callers should include all required API env vars (API keys, SAFE_ID, etc.).
   */
  env?: NodeJS.ProcessEnv;

  /**
   * TCP port the API listens on.
   * Default: 7878 (matches the API's hardcoded default in apps/api/src/main.ts).
   * Override for parallel-spec scenarios to avoid port collisions.
   */
  port?: number;

  /**
   * How long to wait for the "api ready on" log line before rejecting.
   * Default: 20_000 ms.
   */
  readyTimeoutMs?: number;

  /**
   * Prefix for the auto-created temp directory name (used when dbPath is '').
   * Default: 'cclaw-api-test'.
   */
  tmpPrefix?: string;
}

/**
 * Result returned by startApi().
 */
export interface StartApiResult {
  /** Base URL for HTTP requests, e.g. "http://127.0.0.1:7878". */
  url: string;
  /** TCP port the API is listening on. */
  port: number;
  /**
   * Absolute path to the SQLite DB file.
   * Callers that let startApi create the temp dir should hold this for
   * any assertions that read DB state directly.
   */
  dbPath: string;
  /**
   * Send SIGTERM to the API process and wait for it to exit.
   * Also removes the temp directory if startApi created one.
   * Safe to call even if the process already exited.
   */
  kill: () => Promise<void>;
}

/**
 * Spawn the compiled API binary and wait until it is ready.
 *
 * The function handles:
 *   - Optional temp dir creation
 *   - `prisma migrate deploy` for a clean schema
 *   - `spawn('node', [API_DIST])` with the caller's env merged in
 *   - Waiting for the "api ready on" line on stdout
 *   - Exposing a `kill()` teardown that awaits process exit + cleans up the temp dir
 *
 * @throws if the API process exits before printing "api ready on"
 * @throws if readyTimeoutMs elapses before "api ready on" appears
 */
export async function startApi(opts: StartApiOpts): Promise<StartApiResult> {
  const port = opts.port ?? 7878;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 20_000;

  // -------------------------------------------------------------------------
  // Step 1: resolve (or create) the DB path
  // -------------------------------------------------------------------------
  let tempDir: string | null = null;
  let dbPath = opts.dbPath;

  if (!dbPath) {
    const prefix = opts.tmpPrefix ?? 'cclaw-api-test';
    tempDir = mkdtempSync(resolve(tmpdir(), `${prefix}-`));
    dbPath = resolve(tempDir, 'test.db');
  } else {
    // Ensure parent directory exists for caller-provided paths
    mkdirSync(resolve(dbPath, '..'), { recursive: true });
  }

  // -------------------------------------------------------------------------
  // Step 2: run prisma migrate deploy against the fresh DB
  // -------------------------------------------------------------------------
  execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
    env: {
      ...process.env,
      DATABASE_URL: `file:${dbPath}?connection_limit=1`,
      PRISMA_DISABLE_DOTENV: '1',
    },
    cwd: REPO_ROOT,
    stdio: 'ignore',
  });

  // -------------------------------------------------------------------------
  // Step 3: spawn the API process
  // -------------------------------------------------------------------------
  const childEnv: NodeJS.ProcessEnv = {
    // Only propagate PATH/NODE_PATH from parent — everything else the caller
    // must supply explicitly (prevents accidental env leakage in tests).
    PATH: process.env['PATH'],
    NODE_PATH: process.env['NODE_PATH'],
    // Caller env (may override PATH/NODE_PATH if needed)
    ...opts.env,
    // DB location — always override to point at our temp file
    DB_PATH: dbPath,
    DATABASE_URL: `file:${dbPath}?connection_limit=1`,
    PRISMA_DISABLE_DOTENV: '1',
    // Allow port override via PORT env var if the API reads it
    // (currently the API hardcodes 7878 but PR-B may wire this)
    ...(port !== 7878 ? { PORT: String(port) } : {}),
  };

  let apiProcess: ReturnType<typeof spawn> | null = null;

  const started = await new Promise<void>((resolve, reject) => {
    apiProcess = spawn('node', [API_DIST], {
      env: childEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let ready = false;

    const timer = setTimeout(() => {
      if (!ready) {
        reject(new Error(`startApi: API failed to start within ${readyTimeoutMs}ms`));
      }
    }, readyTimeoutMs);

    apiProcess.stdout?.on('data', (chunk: Buffer) => {
      if (!ready && chunk.toString().includes('api ready on')) {
        ready = true;
        clearTimeout(timer);
        resolve();
      }
    });

    apiProcess.on('exit', (code) => {
      if (!ready) {
        clearTimeout(timer);
        reject(new Error(`startApi: API exited with code ${String(code)} before becoming ready`));
      }
    });
  });

  void started; // suppress unused-variable warning — startApi resolves after this

  // -------------------------------------------------------------------------
  // Step 4: build kill() teardown
  // -------------------------------------------------------------------------
  const kill = async (): Promise<void> => {
    if (apiProcess) {
      apiProcess.kill('SIGTERM');
      await new Promise<void>((r) => apiProcess!.on('exit', () => r()));
      apiProcess = null;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
      tempDir = null;
    }
  };

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    dbPath,
    kill,
  };
}
