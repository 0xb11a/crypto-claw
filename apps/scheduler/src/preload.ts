/**
 * Preload module — runs before any other import in apps/scheduler/src/main.ts.
 *
 * Sets PRISMA_DISABLE_DOTENV=1 so @prisma/client's side-effect dotenv load
 * does NOT auto-import the repo-root .env. Without this, a developer with
 * a populated legacy .env (carrying SAFE_SIGNER_KEY for the legacy stack)
 * would trip the boot self-check (assertNoSignerKeysInEnv) on every invocation.
 *
 * Why a separate file: ESM evaluates imported modules' top-level code in source
 * order BEFORE the importing module's own body. Only a side-effect import
 * executes early enough to prevent @prisma/client's dotenv load.
 *
 * Mirror of apps/api/src/preload.ts (P1a) and apps/worker/src/preload.ts (P1c).
 * @see apps/api/src/preload.ts
 * @see apps/worker/src/preload.ts
 */
// eslint-disable-next-line no-restricted-syntax -- bootstrap exception per libs/config policy
process.env['PRISMA_DISABLE_DOTENV'] = '1';
