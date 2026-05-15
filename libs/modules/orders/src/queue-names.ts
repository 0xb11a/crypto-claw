/**
 * queue-names.ts — Canonical queue naming for execute-order BullMQ queues.
 *
 * This file is the single source of truth for the `execute-order-<chain>-<safe>`
 * naming convention described in ADR-0024 (addendum 2026-05-13).
 *
 * Importing from libs/modules/orders keeps the naming logic in the domain layer
 * where it belongs — both the worker (which registers processors) and the
 * service (which enqueues jobs) import from here.
 *
 * Separator: '-' (BullMQ rejects bare ':' in queue names, confirmed in P1c-i).
 */

/**
 * Build the canonical BullMQ queue name for a (chain, safe_address) pair.
 *
 * Format: `execute-order-<chain>-<safeAddressLowercase>`
 *
 * @param chain - Chain identifier, e.g. 'base', 'ethereum', 'solana'.
 * @param safeAddress - The Safe vault or Squads vault address (normalised to lowercase).
 *
 * @example
 *   executeOrderQueueName('base', '0xAbCd') // => 'execute-order-base-0xabcd'
 */
export function executeOrderQueueName(chain: string, safeAddress: string): string {
  return `execute-order-${chain}-${safeAddress.toLowerCase()}`;
}

// ---------------------------------------------------------------------------
// P3g2 PR-D: multisig-tracking queue (global singleton — not per-Safe)
// ---------------------------------------------------------------------------

/**
 * BullMQ queue name for the multisig-tracking job (P3g2 PR-D).
 *
 * Global singleton queue — the tracker scans ALL queued receipts across all
 * Safes in one cycle. ADR-0024 per-Safe concurrency does not apply because
 * this job reads on-chain state (no signer, no nonce) and writes only status
 * fields.
 *
 * Cadence: every 5 minutes (`*\/5 * * * *`), matching `entrypoint.sh:872`
 * (DoD §I — parity).
 */
export const MULTISIG_TRACKING_QUEUE = 'multisig-tracking' as const;

/**
 * Default BullMQ job options for the multisig-tracking queue.
 *
 * Retry policy mirrors P3g1: 2 attempts total, fixed 60 s backoff.
 */
export const MULTISIG_TRACKING_JOB_OPTIONS = {
  attempts: 2,
  backoff: { type: 'fixed' as const, delay: 60_000 },
  removeOnComplete: 50,
  removeOnFail: 20,
} as const;
