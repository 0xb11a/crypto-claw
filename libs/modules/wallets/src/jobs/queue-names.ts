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
