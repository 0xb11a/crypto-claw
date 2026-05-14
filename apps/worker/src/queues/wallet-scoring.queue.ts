/**
 * wallet-scoring.queue.ts — BullMQ queue naming for wallet-scoring jobs.
 *
 * Re-exports `WALLET_SCORING_QUEUE` from the shared domain location
 * (`@cclaw/wallets`) and provides worker-local job option defaults.
 *
 * The constant lives in libs/modules/wallets/src/jobs/queue-names.ts so
 * both the scheduler (enqueue) and the worker (process) import from the
 * same canonical source — no dual-maintenance of the naming convention.
 *
 * Retry policy (P3g1 plan [OPEN-4], user override 2026-05-14):
 *   - 2 attempts total (1 original + 1 retry)
 *   - Fixed backoff: 60_000 ms (60 s) — absorbs transient Redis/network blips
 *   - Completed jobs: retain last 50 (observability, low overhead)
 *   - Failed jobs: retain last 20 (operators need to inspect recent failures)
 *
 * Concurrency policy (P3g1 plan, Queue topology):
 *   Global singleton queue — not per-Safe. concurrency=1 enforced at the
 *   @Processor decorator in ScoreWalletsProcessor. No nonce-collision concern
 *   (wallet pipeline has no on-chain writes; ADR-0024 does not apply here).
 *   ADR-0024 addendum (2026-05-14) clarifies this scope explicitly.
 */

// Re-export from the shared domain location (single source of truth).
export { WALLET_SCORING_QUEUE, WALLET_SCORING_JOB_OPTIONS } from '@cclaw/wallets';
