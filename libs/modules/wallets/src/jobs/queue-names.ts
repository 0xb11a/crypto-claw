/**
 * BullMQ queue name constants for the smart-money wallet pipeline.
 *
 * All three queues are global singletons (not per-Safe) — the wallet
 * pipeline does not write on-chain data so there is no nonce-collision
 * concern (contrast with execute-order, which is per-Safe; ADR-0024).
 *
 * Each constant is the single source of truth. Import from this file in
 * both the producer (scheduler schedule) and the consumer (worker processor)
 * to guarantee naming parity. Never construct these names by hand.
 *
 * P3g1 plan, Queue topology:
 *   harvest:  one cycle per hour   (cron: "0 * * * *")
 *   scoring:  one cycle per 10 min (cron: "* /10 * * * *" — no space, pnpm comment limitation)
 *   activity: one cycle per 30 min (cron: "* /30 * * * *" — no space, pnpm comment limitation)
 */

/** BullMQ queue name for the wallet-harvest job (P3g1 PR-A). */
export const WALLET_HARVEST_QUEUE = 'wallet-harvest' as const;

/**
 * BullMQ queue name for the wallet-scoring job (P3g1 PR-B).
 *
 * Declared here so PR-A can expose the constant to the tester without
 * blocking on PR-B. The processor and schedule land in PR-B.
 */
export const WALLET_SCORING_QUEUE = 'wallet-scoring' as const;

/**
 * BullMQ queue name for the wallet-activity job (P3g1 PR-C).
 *
 * Declared here so PR-A can expose the constant to the tester without
 * blocking on PR-C. The processor and schedule land in PR-C.
 */
export const WALLET_ACTIVITY_QUEUE = 'wallet-activity' as const;

/**
 * Default BullMQ job options for the wallet-pipeline queues.
 *
 * Single source of truth so `WalletsModule.forWorker()` (which registers
 * the queues for DI visibility of `@InjectQueue` in processors) and
 * `apps/worker` / `apps/scheduler` (which used to register them at
 * app-module level) cannot drift.
 *
 * Retry policy (P3g1 plan [OPEN-4], user override 2026-05-14):
 *   - 2 attempts total (1 original + 1 retry)
 *   - Fixed backoff: 60_000 ms — absorbs transient Redis/network blips
 *   - Completed jobs: retain last 50 (observability, low overhead)
 *   - Failed jobs: retain last 20 (operators need to inspect recent failures)
 */
export const WALLET_HARVEST_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;

export const WALLET_SCORING_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;
