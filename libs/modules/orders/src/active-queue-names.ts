/**
 * active-queue-names.ts — Resolve BullMQ queue names from runtime config.
 *
 * Called at boot time (module init) to enumerate all active (chain, safeAddress)
 * pairs and produce the corresponding execute-order queue names.
 *
 * The resolution logic mirrors `scripts/chains.js` priority rules:
 *   - EVM chains: safe address from `SAFE_ADDRESS_<CHAIN_UPPER>` env var,
 *     resolved via chain.safe.addressEnv (e.g. 'SAFE_ADDRESS_BASE').
 *   - Solana: SQUADS_VAULT_ADDRESS takes priority over SQUADS_MULTISIG_ADDRESS
 *     (per CLAUDE.md convention).
 *
 * Chains without a configured safe address are silently skipped — no queue is
 * registered for that chain. Orders for that chain fail at OrdersService.execute()
 * with a descriptive QueueResolver error (not a silent hang).
 *
 * This file has no NestJS deps — it can be called safely from module init code
 * before the DI container is fully ready.
 *
 * @see ADR-0024 addendum — operational consequence: adding a new Safe requires
 *   a worker restart so the new queue's Worker registers.
 */

import { getChain, isEvm, isSolana } from '@cclaw/chain';
import { executeOrderQueueName } from './queue-names.js';

/**
 * Resolve the BullMQ queue names for all active (chain, safe_address) pairs.
 *
 * @param activeChains - Array of chain names from the ACTIVE_CHAINS config field.
 * @param env - Environment record. In app modules, pass a snapshot of the relevant
 *   env vars (the full `process.env` is acceptable here — this fn is called only
 *   from app module init code which is in the ESLint exception block).
 * @returns Array of unique queue names, one per chain that has a safe address configured.
 */
export function resolveActiveQueueNames(activeChains: string[], env: Record<string, string | undefined>): string[] {
  const names: string[] = [];

  for (const chainName of activeChains) {
    let chain;
    try {
      chain = getChain(chainName);
    } catch {
      // Unknown chain name — skip silently
      continue;
    }

    let safeAddress: string | undefined;

    if (isEvm(chain)) {
      // EVM: safe.addressEnv is e.g. 'SAFE_ADDRESS_BASE', 'SAFE_ADDRESS_ETH'
      safeAddress = env[chain.safe.addressEnv];
    } else if (isSolana(chain)) {
      // Solana: SQUADS_VAULT_ADDRESS takes priority over SQUADS_MULTISIG_ADDRESS (CLAUDE.md)
      safeAddress = env[chain.squads.vaultEnv] ?? env[chain.squads.multisigEnv];
    }

    if (safeAddress && safeAddress.trim().length > 0) {
      names.push(executeOrderQueueName(chainName, safeAddress.trim()));
    }
  }

  return names;
}

/**
 * Build the `Map<chainName, queueName>` needed by `QueueResolver`.
 *
 * This is a companion to `resolveActiveQueueNames()` — it returns the same
 * mapping but as a Map keyed by chain name so QueueResolver can look up by chain.
 *
 * @param activeChains - Array of chain names from the ACTIVE_CHAINS config field.
 * @param env - Environment record (same rules as resolveActiveQueueNames).
 * @returns Map<chainName, queueName> for all configured chains.
 */
export function buildChainQueueMap(
  activeChains: string[],
  env: Record<string, string | undefined>,
): Map<string, string> {
  const map = new Map<string, string>();

  for (const chainName of activeChains) {
    let chain;
    try {
      chain = getChain(chainName);
    } catch {
      continue;
    }

    let safeAddress: string | undefined;

    if (isEvm(chain)) {
      safeAddress = env[chain.safe.addressEnv];
    } else if (isSolana(chain)) {
      safeAddress = env[chain.squads.vaultEnv] ?? env[chain.squads.multisigEnv];
    }

    if (safeAddress && safeAddress.trim().length > 0) {
      map.set(chainName, executeOrderQueueName(chainName, safeAddress.trim()));
    }
  }

  return map;
}
