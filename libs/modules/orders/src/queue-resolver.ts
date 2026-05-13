/**
 * queue-resolver.ts — Dynamic BullMQ queue lookup for execute-order queues.
 *
 * Provides `QueueResolver`, an injectable service that resolves the correct
 * BullMQ `Queue` instance for a given chain at enqueue time.
 *
 * Why this exists (ADR-0024 addendum):
 *   The per-Safe concurrency model requires one queue per (chain, safe) pair.
 *   Queue names depend on runtime config (ACTIVE_CHAINS + SAFE_ADDRESS_* env vars).
 *   Static `@InjectQueue` decorators cannot be used because decorators require
 *   compile-time constants.  `ModuleRef.get(getQueueToken(name))` is the
 *   NestJS-recommended pattern for runtime queue selection.
 *
 * Wiring (app modules are responsible):
 *   1. App module computes the chain→queueName map using `resolveActiveQueueNames`.
 *   2. App module registers BullMQ queues via `BullModule.registerQueue` for each name.
 *   3. App module provides `CHAIN_QUEUE_MAP` token with a `Map<string, string>`.
 *   4. `QueueResolver` reads the map and forwards BullMQ lookups to `ModuleRef`.
 *
 * @see queue-names.ts — canonical queue naming function.
 * @see active-queue-names.ts — boot-time queue name enumeration.
 * @see ADR-0024 — per-Safe concurrency derivation.
 */
import { Injectable, Inject } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

/**
 * Injection token for the chain→queueName map.
 *
 * Provided by app modules (apps/api, apps/worker) at boot time.
 * Value type: `Map<string, string>` where key = chain name, value = queue name.
 */
export const CHAIN_QUEUE_MAP = 'CHAIN_QUEUE_MAP' as const;

/**
 * Resolves the correct `Queue` instance for a chain name at enqueue time.
 *
 * The resolver does NOT own any Queue instances — it borrows them from the
 * BullMQ DI container via `ModuleRef.get(getQueueToken(name))`.  All queues
 * must be registered before this service is called (done by the app-level module).
 */
@Injectable()
export class QueueResolver {
  constructor(
    private readonly moduleRef: ModuleRef,
    /** Map of chain name → BullMQ queue name, provided by the app module. */
    @Inject(CHAIN_QUEUE_MAP) private readonly chainQueueMap: Map<string, string>,
  ) {}

  /**
   * Get the BullMQ Queue for the chain that owns the given order.
   *
   * @param chain - Chain identifier, e.g. 'base', 'solana'.
   * @returns The registered Queue instance for the chain's Safe.
   * @throws if no queue is mapped for the chain or the queue is not registered.
   */
  getQueueForChain(chain: string): Queue {
    const queueName = this.chainQueueMap.get(chain);
    if (!queueName) {
      throw new Error(
        `QueueResolver: no queue registered for chain '${chain}'. ` +
          `Ensure the chain is in ACTIVE_CHAINS and its Safe address env var is set.`,
      );
    }
    try {
      // strict: false — search in the global DI context (queue registered in root module).
      const queue = this.moduleRef.get<Queue>(getQueueToken(queueName), { strict: false });
      return queue;
    } catch {
      throw new Error(
        `QueueResolver: queue '${queueName}' not found in DI container for chain '${chain}'. ` +
          `Ensure BullModule.registerQueue({ name: '${queueName}' }) is called in the app module.`,
      );
    }
  }

  /**
   * Get the queue name for a chain (without resolving the Queue object).
   * Useful for logging and deterministic jobId construction.
   *
   * @throws if no queue is mapped for the chain.
   */
  getQueueNameForChain(chain: string): string {
    const queueName = this.chainQueueMap.get(chain);
    if (!queueName) {
      throw new Error(
        `QueueResolver: no queue name mapped for chain '${chain}'. ` +
          `Ensure the chain is in ACTIVE_CHAINS and its Safe address env var is set.`,
      );
    }
    return queueName;
  }
}
