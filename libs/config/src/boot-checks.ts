import { parseEnv, type AppConfig } from './schema.js';

/**
 * Signer-key names that must NEVER appear in api/worker/scheduler env.
 * (SPEC §4 #4, ADR-0010)
 */
const FORBIDDEN_SIGNER_KEYS = ['SAFE_SIGNER_KEY', 'SQUADS_SIGNER_KEY'] as const;

/**
 * Assert that no signer keys are present in the given environment.
 *
 * Called at boot by apps/api, apps/worker, and apps/scheduler.
 * apps/executor does NOT call this function — it is the one process
 * that is permitted to hold signer keys.
 *
 * @param env - The process environment to inspect (pass process.env)
 * @throws {Error} if SAFE_SIGNER_KEY or SQUADS_SIGNER_KEY is non-empty
 */
export function assertNoSignerKeysInEnv(env: NodeJS.ProcessEnv): void {
  for (const key of FORBIDDEN_SIGNER_KEYS) {
    if (env[key] !== undefined && env[key] !== '') {
      throw new Error(
        `[boot] signer keys must not be present in this process env (got: ${key})`,
      );
    }
  }
}

/**
 * Assert that the environment passes the Zod config schema.
 *
 * On validation failure: writes the error message to stderr and exits
 * the process with code 78 (sysexits EX_CONFIG).
 *
 * On success: returns the validated, typed AppConfig.
 *
 * @param env - The process environment to parse (pass process.env)
 * @returns Validated AppConfig
 */
export function assertConfigValid(env: NodeJS.ProcessEnv): AppConfig {
  try {
    return parseEnv(env);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(message + '\n');
    process.exit(78);
  }
}
