/**
 * multisig-tracking.queue.ts — BullMQ queue re-export shim for multisig-tracking.
 *
 * Re-exports `MULTISIG_TRACKING_QUEUE` and job options from the shared domain
 * location (`@cclaw/orders`) so apps/worker and apps/scheduler import from
 * the same canonical source.
 *
 * Queue registration lives inside `OrdersModule.forWorker()` (P3g2 PR-D).
 */

// Re-export from the shared domain location (single source of truth).
export { MULTISIG_TRACKING_QUEUE, MULTISIG_TRACKING_JOB_OPTIONS } from '@cclaw/orders';
