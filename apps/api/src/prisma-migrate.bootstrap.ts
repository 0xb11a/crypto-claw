import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

/**
 * Absolute path to the monorepo root.
 *
 * Resolution order (first wins):
 *   1. PRISMA_REPO_ROOT env var -- set by production compose to "/app" so that
 *      the Prisma CLI and migrations tree are found at the expected locations.
 *      [OPEN-P6-1] resolution: the prod Dockerfile copies prisma/ and
 *      node_modules/.bin/prisma + node_modules/prisma + node_modules/@prisma
 *      to /app (WORKDIR) so runPrismaMigrateDeploy can locate them.
 *   2. resolve(__dirname, '../../..') -- works in CI and local dev where
 *      __dirname resolves to the repo root apps/api/src/ (or dist/) subtree.
 *
 * Pattern mirrors tests/integration/_spawn-api.ts:32.
 *
 * process.env is read here per the apps bootstrap exception in CLAUDE.md.
 */
const REPO_ROOT = process.env['PRISMA_REPO_ROOT'] ?? resolve(__dirname, '../../..');

/** Prisma CLI binary (resolved from monorepo root node_modules). */
const PRISMA_BIN = resolve(REPO_ROOT, 'node_modules/.bin/prisma');

/**
 * Run `prisma migrate deploy` against the configured database.
 *
 * Invokes the Prisma CLI as a child process so the migration engine runs in its
 * own process context. The child inherits the provided `env` object -- callers
 * must ensure DATABASE_URL is present and that SAFE_SIGNER_KEY /
 * SQUADS_SIGNER_KEY are NOT present (enforced by assertNoSignerKeysInEnv
 * which MUST run before this function in the boot sequence; SPEC section 4 rule 4).
 *
 * Boot order invariant (main.ts):
 *   1. assertNoSignerKeysInEnv  -- signer isolation check MUST come first
 *   2. assertConfigValid         -- env schema validation
 *   3. runPrismaMigrateDeploy    -- this function (child inherits already-clean env)
 *   4. NestFactory.create        -- app bootstrap
 *
 * On success the function returns normally.
 * On failure (non-zero exit code) execFileSync throws -- the bootstrap .catch()
 * block in main.ts writes the error to stderr and calls process.exit(1).
 * Migration errors are NOT exit-78 (that code is reserved for config errors).
 *
 * Idempotent: Prisma's _prisma_migrations table check ensures already-applied
 * migrations are skipped. For SQLite, concurrent invocations are serialized by
 * WAL file-locking — advisory locks are a Postgres-only feature and do not apply
 * here. In the current single-writer topology only apps-api ever calls
 * migrate-deploy, so concurrent invocations cannot occur in practice.
 *
 * @param env - Environment variables to pass to the Prisma child process.
 *              Must include DATABASE_URL. Callers in apps bootstrap files may
 *              pass process.env directly (bootstrap exception block; see CLAUDE.md).
 */
export function runPrismaMigrateDeploy(env: NodeJS.ProcessEnv): void {
  execFileSync(PRISMA_BIN, ['migrate', 'deploy'], {
    env,
    stdio: 'inherit',
    cwd: REPO_ROOT,
  });
}
