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
  /** 1inch DEX aggregator API key. Required for EVM real-mode execution (P1c-ii). */
  ONEINCH_API_KEY: apiKey().optional(),
  // --------------------------------------------------------------------------
  // EVM explorer API keys (P3g1 PR-C — consumed by EvmExplorerAdapter)
  // Optional: chains without a key skip EVM activity polling for that chain.
  // --------------------------------------------------------------------------
  /** Basescan API key — required when ACTIVE_CHAINS includes 'base'. */
  BASESCAN_API_KEY: apiKey().optional(),
  /** Etherscan API key — required when ACTIVE_CHAINS includes 'ethereum'. */
  ETHERSCAN_API_KEY: apiKey().optional(),
  /** Arbiscan API key — required when ACTIVE_CHAINS includes 'arbitrum'. */
  ARBISCAN_API_KEY: apiKey().optional(),
  /** Polygonscan API key — required when ACTIVE_CHAINS includes 'polygon'. */
  POLYGONSCAN_API_KEY: apiKey().optional(),
  /** BscScan API key — required when ACTIVE_CHAINS includes 'bsc'. */
  BSCSCAN_API_KEY: apiKey().optional(),
  /** Optimistic Etherscan API key — required when ACTIVE_CHAINS includes 'optimism'. */
  OPTIMISTIC_ETHERSCAN_API_KEY: apiKey().optional(),

  // --------------------------------------------------------------------------
  // Chain RPC URLs (P1c-ii — consumed by apps/executor real EVM SDK)
  // --------------------------------------------------------------------------
  /** RPC URL for Base chain (required when ACTIVE_CHAINS includes 'base'). */
  RPC_BASE: z.string().url().optional(),
  /** RPC URL for Ethereum chain (required when ACTIVE_CHAINS includes 'ethereum'). */
  RPC_ETH: z.string().url().optional(),
  /** RPC URL for Solana (required when ACTIVE_CHAINS includes 'solana'). */
  RPC_SOL: z.string().url().optional(),

  // --------------------------------------------------------------------------
  // Safe wallet addresses (P1c-ii — consumed by apps/executor real EVM SDK)
  // --------------------------------------------------------------------------
  /** Safe multisig address on Base. */
  SAFE_ADDRESS_BASE: z.string().optional(),
  /** Safe multisig address on Ethereum mainnet. */
  SAFE_ADDRESS_ETH: z.string().optional(),

  // --------------------------------------------------------------------------
  // Squads multisig addresses (P1c-iii — consumed by apps/executor Solana SDK)
  // --------------------------------------------------------------------------
  /**
   * Squads vault address (direct). Takes priority over SQUADS_MULTISIG_ADDRESS.
   * If set, the executor uses this address directly as the vault PDA.
   * At least one of SQUADS_VAULT_ADDRESS / SQUADS_MULTISIG_ADDRESS is required
   * when ACTIVE_CHAINS includes 'solana' and EXECUTOR_STUB_MODE is not '1'.
   */
  SQUADS_VAULT_ADDRESS: z.string().optional(),
  /**
   * Squads multisig PDA address. Used to derive the vault PDA when
   * SQUADS_VAULT_ADDRESS is not set.
   */
  SQUADS_MULTISIG_ADDRESS: z.string().optional(),

  // --------------------------------------------------------------------------
  // RPC security (P1c-ii)
  // --------------------------------------------------------------------------
  /**
   * RPC URL allowlist validation mode.
   *   strict (default) — reject if hostname not in allowlist (fail-closed).
   *   warn             — log warning but continue (rollout mode).
   *   skip             — bypass check entirely (genuine outage / new provider).
   */
  RPC_VALIDATION_MODE: z.enum(['strict', 'warn', 'skip']).default('strict'),

  // --------------------------------------------------------------------------
  // Telegram (SPEC §10)
  // --------------------------------------------------------------------------
  TELEGRAM_BOT_TOKEN: z.string().optional(),
  TELEGRAM_CHAT_ID: z.string().optional(),
  /**
   * Telegram user ID (numeric string) of the fund owner.
   *
   * Required when `TELEGRAM_BOT_TOKEN` is set and approval-bot is active.
   * Only this user's callback_query events are processed; all others receive
   * an "Unauthorized" answer and are skipped (ADR-0027, DoD §F).
   */
  TELEGRAM_OWNER_ID: z.string().optional(),
  /**
   * Telegram bot token for the dedicated approval bot (optional, P3g3).
   *
   * When absent, the approval-bot runs under `TELEGRAM_BOT_TOKEN` (main bot).
   * Reserved here per the P3g2 plan — actual consumption deferred to P3g3 if
   * a separate bot token is needed to avoid polling conflicts.
   * For P3g3 (this PR), `ApprovalBotService` uses `TELEGRAM_BOT_TOKEN`.
   */
  TELEGRAM_APPROVAL_BOT_TOKEN: z.string().optional(),

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
  // Telegram topic thread IDs (SPEC §10 — per-topic routing)
  // --------------------------------------------------------------------------
  /**
   * Telegram forum topic thread IDs. All optional — if absent for a given
   * alert type, the message is sent without a thread_id (falls to main chat).
   */
  TG_TOPIC_RESEARCH: z.string().optional(),
  TG_TOPIC_SENTINEL: z.string().optional(),
  TG_TOPIC_EXECUTOR: z.string().optional(),
  TG_TOPIC_ALERTS: z.string().optional(),
  TG_TOPIC_SYSTEM: z.string().optional(),
  TG_TOPIC_OBSERVER: z.string().optional(),
  TG_TOPIC_PORTFOLIO: z.string().optional(),
  TG_TOPIC_APPROVALS: z.string().optional(),

  // --------------------------------------------------------------------------
  // Governance-drift expected config (P3g2 PR-D — SPEC §10)
  // --------------------------------------------------------------------------
  /**
   * Comma-separated lowercase EVM owner addresses expected on the Base Safe.
   *
   * ADR-0026 exception: these are runtime-keyed per-chain fields. The processor
   * resolves the suffix from ACTIVE_CHAINS at runtime via
   * `configService.get<string>('EXPECTED_SAFE_OWNERS_' + chain.toUpperCase())`.
   * The full set of possible key names is bounded and listed here.
   */
  EXPECTED_SAFE_OWNERS_BASE: z.string().optional(),
  EXPECTED_SAFE_OWNERS_ETHEREUM: z.string().optional(),

  /**
   * Expected signing threshold for the Base/Ethereum Safe (integer).
   * Absence means "no expectation set" — governance check is skipped for that field.
   */
  EXPECTED_SAFE_THRESHOLD_BASE: z.coerce.number().int().positive().optional(),
  EXPECTED_SAFE_THRESHOLD_ETHEREUM: z.coerce.number().int().positive().optional(),

  /**
   * Comma-separated lowercase module addresses allowed on the Base/Ethereum Safe.
   * Absence means no module expectation — any unexpected module triggers an alert.
   */
  EXPECTED_SAFE_MODULES_BASE: z.string().optional(),
  EXPECTED_SAFE_MODULES_ETHEREUM: z.string().optional(),

  /**
   * Comma-separated Squads member public keys (base58, case-sensitive).
   * Used for Solana governance drift check.
   */
  EXPECTED_SQUADS_MEMBERS: z.string().optional(),

  /**
   * Expected Squads signing threshold (integer).
   */
  EXPECTED_SQUADS_THRESHOLD: z.coerce.number().int().positive().optional(),

  // --------------------------------------------------------------------------
  // Background pipeline job tuning (P3g1)
  // --------------------------------------------------------------------------

  /**
   * Wall-clock cap for one wallet-harvest BullMQ job invocation (ms).
   *
   * The harvest processor passes this value to `AbortSignal.timeout()` so a
   * stuck Birdeye HTTP call does not hold up the hourly cron slot. Default:
   * 300_000 ms (5 min) — conservative relative to the hourly cadence.
   *
   * Operator tunable: raise if Birdeye is legitimately slow on a large chain
   * list; lower if you want tighter SLO enforcement on the harvest cycle.
   */
  WALLET_HARVEST_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),

  /**
   * Per-wallet AbortController timeout for the wallet-scoring BullMQ processor (ms).
   *
   * Controls how long a single wallet's three parallel API calls
   * (Birdeye trader rank + token top traders + Zerion PnL) are allowed to run
   * before they are aborted and the wallet is marked 'failed'. Default:
   * 30_000 ms (30 s) — matches the legacy `execFileSync` 30 s timeout in
   * `scripts/score-wallets-bg.js:131` (DoD §I — parity).
   *
   * Operator tunable: raise if Birdeye or Zerion is legitimately slow;
   * lower for a tighter SLO on the 10-minute scoring cadence.
   */
  WALLET_SCORING_PER_WALLET_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),

  /**
   * Inter-wallet delay for the wallet-scoring processor (ms).
   *
   * The processor waits this many ms between wallets in a cycle to respect
   * Birdeye and Zerion rate limits. Default: 3_000 ms (3 s) — matches the
   * legacy `DELAY_MS = 3000` in `scripts/score-wallets-bg.js:34` (DoD §I).
   *
   * Operator tunable: raise if hitting 429 rate limits; lower if quotas allow.
   */
  WALLET_SCORING_INTER_WALLET_DELAY_MS: z.coerce.number().int().nonnegative().default(3_000),

  /**
   * Per-fetch timeout for the wallet-activity BullMQ processor (ms).
   *
   * Controls how long a single wallet's Helius or Etherscan-compatible fetch
   * is allowed to run before it is aborted via `AbortSignal.timeout()`. Default:
   * 10_000 ms (10 s) — matches the legacy `FETCH_TIMEOUT_MS = 10_000` in
   * `scripts/activity-wallets-bg.js:43` (DoD §I — parity).
   */
  WALLET_ACTIVITY_PER_FETCH_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

  /**
   * Per-chain consecutive-timeout threshold for the wallet-activity processor.
   *
   * After this many consecutive timeouts on a single chain in one cycle, the
   * processor skips the remaining wallets on that chain. Default: 5 — matches
   * the legacy `FAIL_FAST_CONSECUTIVE = 5` in `scripts/activity-wallets-bg.js:45`.
   * Counter resets on each job invocation (per-job scope, per legacy parity).
   */
  WALLET_ACTIVITY_PER_CHAIN_TIMEOUT_LIMIT: z.coerce.number().int().positive().default(5),

  /**
   * Inter-wallet delay for the wallet-activity processor (ms).
   *
   * The processor waits this many ms between wallets within the same chain to
   * respect per-chain rate limits. Default: 250 ms — matches the legacy
   * `PER_CHAIN_DELAY_MS = 250` in `scripts/activity-wallets-bg.js:44`.
   */
  WALLET_ACTIVITY_INTER_WALLET_DELAY_MS: z.coerce.number().int().nonnegative().default(250),

  // --------------------------------------------------------------------------
  // Position-reconcile + portfolio-report job tuning (P3g2 PR-E)
  // --------------------------------------------------------------------------

  /**
   * UTC hour (0–23) for the daily portfolio report Telegram message.
   *
   * If absent (undefined), the portfolio-report schedule is not registered —
   * consistent with `entrypoint.sh:run_portfolio_report_loop` which checks
   * TELEGRAM_CHAT_ID and PORTFOLIO_REPORT_HOUR before starting the cron.
   * Default: 0 (midnight UTC).
   *
   * [OPEN-5] resolution: cron-at-hour approach (SchedulerRegistry.addCronJob)
   * rather than hourly-poll-with-gate, matching DoD §I parity intent.
   */
  PORTFOLIO_REPORT_HOUR: z.coerce.number().int().min(0).max(23).default(0),

  /**
   * Position-reconcile drift tolerance in USD.
   *
   * Position pairs with absolute drift below this threshold are ignored.
   * Default: 1 (USD) — matches legacy `scripts/reconcile-positions.js`
   * which uses the `evaluatePositionDrift` default `maxDriftPct=1` (percentage,
   * not USD — kept for operator tuning reference in the runbook).
   */
  RECONCILE_TOLERANCE_PCT: z.coerce.number().nonnegative().default(1),

  /**
   * DEXScreener per-request timeout in milliseconds.
   *
   * Used by DexscreenerAdapter for portfolio-summary price fetches.
   * Default: 15_000 ms. Operator tunable.
   */
  DEXSCREENER_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),

  /**
   * DeBank API access key for EVM on-chain balance fetches.
   *
   * Used by portfolio-load-evm.js (legacy) and future DeBank adapter integration.
   * Optional — balance reads fall back to direct RPC calls when absent.
   */
  DEBANK_ACCESS_KEY: z.string().optional(),

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
