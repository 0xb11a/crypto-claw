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
