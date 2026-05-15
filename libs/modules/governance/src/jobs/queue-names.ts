/**
 * BullMQ queue name constants for the governance-drift job.
 *
 * The governance-drift queue is a global singleton (not per-Safe) — it reads
 * on-chain Safe/Squads config and compares against expected values. It has
 * no on-chain write step, so ADR-0024 per-Safe concurrency does not apply.
 *
 * Cadence: daily at midnight (`0 0 * * *`), matching `sleep 86400` in
 * `entrypoint.sh:811` (DoD §I — parity).
 *
 * P3g2 plan, Queue topology:
 *   governance-drift: once per day (cron: "0 0 * * *")
 */

/** BullMQ queue name for the governance-drift job (P3g2 PR-D). */
export const GOVERNANCE_DRIFT_QUEUE = 'governance-drift' as const;

/**
 * Default BullMQ job options for the governance-drift queue.
 *
 * Retry policy mirrors P3g1: 2 attempts total, fixed 60 s backoff.
 * Completed jobs: retain last 50. Failed jobs: retain last 20.
 */
export const GOVERNANCE_DRIFT_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;
