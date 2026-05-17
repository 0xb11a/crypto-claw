import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Absolute path to the monorepo root.
 *
 * `__dirname` in this file resolves to `apps/api/src/` (or its dist equivalent),
 * so we go up three levels to reach the repo root.
 *
 * Pattern mirrors `tests/integration/_spawn-api.ts:32` (REPO_ROOT = resolve(__dirname, '../..')).
 * Here we add one more `..` because this file is one directory deeper (src/).
 */
const REPO_ROOT = resolve(__dirname, '../../..');

/** Prisma CLI binary (resolved from monorepo root node_modules). */
const PRISMA_BIN = resolve(REPO_ROOT, 'node_modules/.bin/prisma');

/**
 * Run `prisma migrate deploy` against the configured database.
 *
 * Invokes the Prisma CLI as a child process so the migration engine runs in its
 * own process context.  The child inherits the provided `env` object — callers
 * must ensure `DATABASE_URL` is present and that `SAFE_SIGNER_KEY` /
 * `SQUADS_SIGNER_KEY` are NOT present (enforced by `assertNoSignerKeysInEnv`
 * which MUST run before this function in the boot sequence; SPEC §4 #4).
 *
 * Boot order invariant (main.ts):
 *   1. assertNoSignerKeysInEnv  ← signer isolation check MUST come first
 *   2. assertConfigValid         ← env schema validation
 *   3. runPrismaMigrateDeploy    ← this function (child inherits already-clean env)
 *   4. NestFactory.create        ← app bootstrap
 *
 * On success the function returns normally.
 * On failure (non-zero exit code) execFileSync throws — the bootstrap .catch()
 * block in main.ts writes the error to stderr and calls process.exit(1).
 * Migration errors are NOT exit-78 (that code is reserved for config errors).
 *
 * Idempotent: Prisma's `_prisma_migrations` advisory lock ensures only one
 * concurrent `migrate deploy` proceeds; subsequent calls with an up-to-date
 * schema are instant no-ops.
 *
 * @param env - Environment variables to pass to the Prisma child process.
 *              Must include DATABASE_URL.  Callers in apps bootstrap files may
 *              pass process.env directly (process.env is permitted in the
 *              apps bootstrap exception block; see CLAUDE.md).
 */
export function runPrismaMigrateDeploy(env: NodeJS.ProcessEnv): void {
  execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
    env,
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
}
