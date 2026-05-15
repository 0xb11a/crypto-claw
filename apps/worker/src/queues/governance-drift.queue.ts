/**
 * governance-drift.queue.ts — BullMQ queue re-export shim for governance-drift.
 *
 * Re-exports `GOVERNANCE_DRIFT_QUEUE` and job options from the shared domain
 * location (`@cclaw/governance`) so apps/worker and apps/scheduler import from
 * the same canonical source — no dual-maintenance of the naming convention.
 *
 * Queue registration lives inside `GovernanceModule.forWorker()` (P3g2 plan,
 * PR-B/D fix pattern). This file is a thin re-export shim only.
 */

// Re-export from the shared domain location (single source of truth).
export { GOVERNANCE_DRIFT_QUEUE, GOVERNANCE_DRIFT_JOB_OPTIONS } from '@cclaw/governance';
