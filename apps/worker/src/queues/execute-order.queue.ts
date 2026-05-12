/**
 * execute-order.queue.ts — BullMQ queue registration for execute-order jobs.
 *
 * Provides the BullModule.registerQueue config for the 'execute-order' queue.
 * Import this constant into any module that needs to enqueue or process jobs.
 *
 * Retry policy (ADR-0024):
 *   - 3 attempts total (1 original + 2 retries)
 *   - Exponential backoff starting at 2000ms
 *   - Completed jobs: retain last 100 (audit trail, low overhead)
 *   - Failed jobs: retain all (operators need to inspect failures)
 *
 * Concurrency policy (ADR-0024):
 *   - Global concurrency = 1 in P1c-i (one executor child at a time across all orders)
 *   - P1c-ii replaces with per-Safe-address groups
 */

/** Canonical queue name for the execute-order processor. */
export const EXECUTE_ORDER_QUEUE = 'execute-order' as const;

/** Default BullMQ job options for execute-order jobs. */
export const EXECUTE_ORDER_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: false,
} as const;
