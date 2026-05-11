import { z } from 'zod';

/**
 * Minimum length for bearer-token API keys.
 * 32-char URL-safe random is the canonical format (SPEC §9.1).
 * 16 is accepted in CI/test contexts to allow shorter dummy values.
 */
const MIN_KEY_LEN = 16;

/**
 * Helper that enforces minimum key length and produces a diagnostic
 * message that matches the boot-fail format: [config] invalid env: <field> — <reason>.
 */
function apiKey(minLen = MIN_KEY_LEN) {
  return z
    .string()
    .min(
      minLen,
      `must be at least ${minLen} characters (generate with: openssl rand -base64 32 | tr -d '/+=' | head -c 32)`,
    );
}

/**
 * Zod schema for the full runtime environment.
 *
 * SPEC §10 is authoritative. Required fields cause a boot-fail on the
 * first missing/malformed value; optional fields carry typed defaults.
 *
 * The schema is parsed by assertConfigValid() in boot-checks.ts, which
 * formats errors as:
 *   [config] invalid env: <field> — <reason>
 *
 * Note: SAFE_SIGNER_KEY and SQUADS_SIGNER_KEY are not listed here because
 * they are forbidden in api/worker/scheduler environments. They are handled
 * by assertNoSignerKeysInEnv() as a separate boot-check, not a schema parse.
 */
export const envSchema = z.object({
  // --------------------------------------------------------------------------
  // Fund identity (SPEC §10)
  // --------------------------------------------------------------------------
  /** Fund identifier; selects the SQLite filename data/<SAFE_ID>.db */
  SAFE_ID: z.string().min(1, 'Required'),

  /** Absolute or relative path to the SQLite database file */
  DB_PATH: z.string().optional(),

  // --------------------------------------------------------------------------
  // Infrastructure
  // --------------------------------------------------------------------------
  /** Redis URL for BullMQ (e.g. redis://redis:6379) */
  REDIS_URL: z.string().url('must be a valid URL (e.g. redis://redis:6379)'),

  // --------------------------------------------------------------------------
  // Bearer tokens — per-identity (SPEC §9.1)
  // --------------------------------------------------------------------------
  RESEARCH_API_KEY: apiKey(),
  SENTINEL_API_KEY: apiKey(),
  EXECUTOR_API_KEY: apiKey(),
  OBSERVER_API_KEY: apiKey(),
  LOOP_API_KEY: apiKey(),
  WORKER_API_KEY: apiKey(),
  SCHEDULER_API_KEY: apiKey(),
  /** Dashboard role token — read-only. Required at boot even in P0 so future frontends don't require a restart. */
  DASHBOARD_API_KEY: apiKey(),

  // --------------------------------------------------------------------------
  // Active chains (SPEC §10)
  // --------------------------------------------------------------------------
  /** Comma-separated list of active chain names (e.g. base,ethereum,solana) */
  ACTIVE_CHAINS: z.string().min(1, 'Required — comma-separated list of active chains'),

  // --------------------------------------------------------------------------
  // LLM / model providers (SPEC §10)
  // --------------------------------------------------------------------------
  /**
   * OpenAI API key. Required unless Codex OAuth is configured.
   * In P0 CI we supply a dummy value; real deployments need a valid key.
   */
  OPENAI_API_KEY: z.string().min(1, 'Required (or configure Codex OAuth)').optional(),

  // --------------------------------------------------------------------------
  // Data API keys (SPEC §10)
  // --------------------------------------------------------------------------
  BIRDEYE_API_KEY: apiKey().optional(),
  HELIUS_API_KEY: apiKey().optional(),
  ZERION_API_KEY: apiKey().optional(),
  ONEINCH_API_KEY: apiKey().optional(),

  // --------------------------------------------------------------------------
  // Telegram (SPEC §10)
  // --------------------------------------------------------------------------
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  TELEGRAM_OWNER_ID: z.string().optional(),

  // --------------------------------------------------------------------------
  // Optional — with typed defaults
  // --------------------------------------------------------------------------
  /** Paper-mode toggle. Default false. */
  PAPER_MODE: z
    .enum(['true', 'false', ''])
    .transform((v) => v === 'true')
    .default('false'),

  /** Starting balance for paper mode in USD. Default 10000. */
  PAPER_STARTING_BALANCE: z
    .string()
    .transform((v) => parseFloat(v))
    .refine((v) => !isNaN(v) && v > 0, 'must be a positive number')
    .default('10000'),

  /** Auto-approve BUY orders without human confirmation (real mode only). Default false. */
  AUTO_APPROVE_BUY: z
    .enum(['true', 'false', ''])
    .transform((v) => v === 'true')
    .default('false'),

  // --------------------------------------------------------------------------
  // Executor subprocess — consumed by apps/worker (SPEC §4 #4, ADR-0023)
  // --------------------------------------------------------------------------

  /**
   * Absolute path to the executor binary (apps/executor/dist/main.js).
   * Optional — defaults are resolved at runtime by libs/execution/executor-path.ts.
   * Override via EXECUTOR_BIN_PATH in .env.runtime for non-standard layouts.
   */
  EXECUTOR_BIN_PATH: z.string().optional(),

  /**
   * Stub mode flag for apps/executor.
   * When '1', the executor returns deterministic fake receipts instead of
   * making real Safe/Squads transactions. Must be '0' or unset in production.
   *
   * Default: false (production-safe default — stub mode must be opted in).
   */
  EXECUTOR_STUB_MODE: z
    .enum(['1', '0', 'true', 'false', ''])
    .transform((v) => v === '1' || v === 'true')
    .default('0'),

  /**
   * Path to the signer env file (mode 0400).
   * The worker reads this file at spawn time to inject SAFE_SIGNER_KEY and
   * SQUADS_SIGNER_KEY into the executor child's env.
   *
   * Default: /run/secrets/signer.env (Docker bind-mount path per ADR-0023).
   */
  SIGNER_ENV_FILE: z.string().default('/run/secrets/signer.env'),

  // --------------------------------------------------------------------------
  // Runtime behaviour — consumed by libs/logger (SPEC §11)
  // --------------------------------------------------------------------------

  /**
   * Pino log level. Default 'info'.
   * Controls verbosity across all NestJS apps at runtime.
   */
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  /**
   * Node runtime environment. Default 'development'.
   * Used by libs/logger to select pino-pretty transport in non-production mode.
   */
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});

/** Typed AppConfig shape derived from the Zod schema. */
export type AppConfig = z.infer<typeof envSchema> & {
  /** Resolved DB path — defaults to ./data/<SAFE_ID>.db */
  DB_PATH: string;
};

/**
 * Parse process.env against the schema and return typed config.
 *
 * Throws an Error with a message starting `[config] invalid env: <field> — <reason>`
 * on the first validation failure.
 *
 * @throws {Error} if any required env var is missing or malformed
 */
export function parseEnv(env: NodeJS.ProcessEnv): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const first = result.error.issues[0];
    // Field path: top-level keys are stored as the first element of the path array
    const field = first.path.length > 0 ? String(first.path[0]) : 'unknown';
    const reason = first.message;
    throw new Error(`[config] invalid env: ${field} — ${reason}`);
  }

  const data = result.data;

  return {
    ...data,
    // Resolve DB_PATH default: ./data/<SAFE_ID>.db
    DB_PATH: data.DB_PATH ?? `./data/${data.SAFE_ID}.db`,
  };
}
