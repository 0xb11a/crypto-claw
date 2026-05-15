/**
 * queue-names.ts — Canonical queue naming for position-reconcile BullMQ queue.
 *
 * The position-reconcile queue is a global singleton — it scans ALL open/partial_exit
 * positions in one cycle. ADR-0024 per-Safe concurrency does not apply because this
 * job only reads on-chain state (no signer, no nonce) and writes only to positions.notes.
 *
 * Cadence: `0 * * * *` (hourly) — mirrors `sleep 3600` in `entrypoint.sh`
 * run_position_reconcile_loop (DoD §I — parity).
 *
 * P3g2 plan, Queue topology:
 *   position-reconcile: once per hour (cron: "0 * * * *")
 */

/** BullMQ queue name for the position-reconcile job (P3g2 PR-E). */
export const POSITION_RECONCILE_QUEUE = 'position-reconcile' as const;

/**
 * Default BullMQ job options for the position-reconcile queue.
 *
 * Retry policy mirrors P3g1: 2 attempts total, fixed 60 s backoff.
 * Completed jobs: retain last 50. Failed jobs: retain last 20.
 */
export const POSITION_RECONCILE_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;
