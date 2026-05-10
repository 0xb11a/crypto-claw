/**
 * Preload module — runs before any other import in apps/api/src/main.ts.
 *
 * Sets PRISMA_DISABLE_DOTENV=1 so @prisma/client's side-effect dotenv load
 * does NOT auto-import the repo-root .env. Without this, a developer with
 * a populated legacy .env (carrying SAFE_SIGNER_KEY for the legacy stack)
 * would trip the boot self-check (assertNoSignerKeysInEnv) on every
 * pnpm dev:api / pnpm run build:openapi / pnpm run build:sdk invocation.
 *
 * Why a separate file instead of inline at the top of main.ts: ESM evaluates
 * imported modules' top-level code in source order BEFORE the importing
 * module's own body. A statement inline in main.ts's body runs AFTER all
 * imports — including the one that transitively loads @prisma/client. Only
 * a side-effect import statement (this file) executes early enough.
 *
 * In production Docker, the cwd has no .env so this is a no-op. In CI, the
 * env is set explicitly at the workflow level. This module exists for the
 * local DevX path.
 *
 * See ADR-0019 (route walker boot order) and the P1a reviewer's nit #2.
 */
// eslint-disable-next-line no-restricted-syntax -- bootstrap exception per libs/config policy
process.env['PRISMA_DISABLE_DOTENV'] = '1';
