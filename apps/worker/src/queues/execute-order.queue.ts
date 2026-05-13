/**
 * execute-order.queue.ts — BullMQ queue naming for execute-order jobs.
 *
 * Re-exports `executeOrderQueueName` from the shared domain location
 * (`@cclaw/orders`) and provides worker-local job option defaults.
 *
 * The naming function lives in libs/modules/orders/src/queue-names.ts so
 * both the API (enqueue) and the worker (process) import from the same
 * canonical source — no dual-maintenance of the naming convention.
 *
 * Retry policy (ADR-0024):
 *   - 3 attempts total (1 original + 2 retries)
 *   - Exponential backoff starting at 2000ms
 *   - Completed jobs: retain last 100 (audit trail, low overhead)
 *   - Failed jobs: retain all (operators need to inspect failures)
 *
 * Concurrency policy (ADR-0024, addendum 2026-05-13):
 *   - One BullMQ queue per (chain, safe_address) pair; concurrency = 1 per queue.
 *   - Queue name format: execute-order-<chain>-<safeAddressLowercase>
 *   - Separator: '-' (BullMQ rejects bare ':' per P1c-i finding).
 */

// Re-export from the shared domain location (single source of truth per ADR-0024 addendum).
export { executeOrderQueueName } from '@cclaw/orders';

/** Default BullMQ job options for execute-order jobs. */
export const EXECUTE_ORDER_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential' as const, delay: 2000 },
  removeOnComplete: 100,
  removeOnFail: false,
} as const;

/**
 * Legacy constant — kept only for the P1c-i → P1c-ii migration window.
 *
 * @deprecated Use `executeOrderQueueName(chain, safeAddress)` instead.
 *   This constant can be deleted once all references are migrated.
 */
export const EXECUTE_ORDER_QUEUE = 'execute-order' as const;
