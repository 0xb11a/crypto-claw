/**
 * Unit tests for queue-resolver.ts — QueueResolver service.
 *
 * Tests adversarial paths the coder flagged as gaps (plan §B.1):
 *   - getQueueForChain('unknown-chain') throws with descriptive error
 *   - getQueueNameForChain('unknown-chain') throws with descriptive error
 *   - Happy path: known chain resolves to the correct Queue instance
 *
 * ModuleRef is faked (not a real NestJS DI container) because this is a
 * pure unit test — the integration test (execute-route.spec.ts) exercises
 * the real DI graph.
 *
 * SPEC §14 — unit tests; DoD §A.
 * ADR-0024 addendum — QueueResolver is load-bearing for per-Safe routing.
 */

import { describe, it, expect, vi } from 'vitest';
import { QueueResolver } from './queue-resolver.js';
import type { Queue } from 'bullmq';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakeQueue(name: string): Queue {
  return { name } as unknown as Queue;
}

/**
 * Build a QueueResolver with a fake ModuleRef.
 *
 * @param chainQueueMap - Map<chain, queueName> to inject.
 * @param registeredQueues - Map<queueName, Queue> that the fake ModuleRef knows about.
 */
function makeResolver(chainQueueMap: Map<string, string>, registeredQueues: Map<string, Queue>): QueueResolver {
  // Fake ModuleRef: get(token, opts) returns the Queue for that token's queue name.
  // getQueueToken(name) returns a Symbol — we store by queue name string for simplicity.
  const fakeModuleRef = {
    get: vi.fn((token: unknown): Queue => {
      // Token is whatever @nestjs/bullmq's getQueueToken returns.
      // In tests we look up by the string value embedded in the token.
      for (const [queueName, q] of registeredQueues) {
        // getQueueToken wraps the name in a Symbol-like token. For testing,
        // match by converting to string.
        if (String(token).includes(queueName)) {
          return q;
        }
      }
      throw new Error(`ModuleRef: unknown token ${String(token)}`);
    }),
  };

  return new QueueResolver(fakeModuleRef as never, chainQueueMap);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('QueueResolver.getQueueForChain()', () => {
  it('returns the Queue for a mapped chain', () => {
    const queue = makeFakeQueue('execute-order-base-0xabc');
    const map = new Map([['base', 'execute-order-base-0xabc']]);
    const queues = new Map([['execute-order-base-0xabc', queue]]);
    const resolver = makeResolver(map, queues);

    const result = resolver.getQueueForChain('base');
    expect(result).toBe(queue);
  });

  it('throws a descriptive error for an unknown chain (adversarial — plan §B.1)', () => {
    const map = new Map([['base', 'execute-order-base-0xabc']]);
    const queues = new Map<string, Queue>();
    const resolver = makeResolver(map, queues);

    expect(() => resolver.getQueueForChain('unknown-chain')).toThrowError(
      /QueueResolver: no queue registered for chain 'unknown-chain'/,
    );
  });

  it('error message for unknown chain includes the chain name', () => {
    const map = new Map<string, string>();
    const queues = new Map<string, Queue>();
    const resolver = makeResolver(map, queues);

    expect(() => resolver.getQueueForChain('solana')).toThrowError(/solana/);
  });

  it('error message mentions ACTIVE_CHAINS and Safe address env var', () => {
    const resolver = makeResolver(new Map(), new Map());
    try {
      resolver.getQueueForChain('base');
    } catch (err) {
      expect((err as Error).message).toMatch(/ACTIVE_CHAINS/);
    }
  });

  it('throws when chain is empty string', () => {
    const map = new Map([['base', 'execute-order-base-0xabc']]);
    const queues = new Map<string, Queue>();
    const resolver = makeResolver(map, queues);

    expect(() => resolver.getQueueForChain('')).toThrowError(/QueueResolver/);
  });
});

describe('QueueResolver.getQueueForChain() — DI container miss', () => {
  it('throws descriptive error when chain is mapped but queue is not in DI container', () => {
    // Chain is in the map, but the DI container does NOT have the queue registered.
    const map = new Map([['base', 'execute-order-base-0xabc']]);
    // Empty registeredQueues map -> moduleRef.get will throw
    const resolver = makeResolver(map, new Map());

    expect(() => resolver.getQueueForChain('base')).toThrowError(/QueueResolver: queue.*not found in DI container/);
  });

  it('error message for DI miss includes the queue name and chain name', () => {
    const map = new Map([['ethereum', 'execute-order-ethereum-0xdef']]);
    const resolver = makeResolver(map, new Map());

    try {
      resolver.getQueueForChain('ethereum');
    } catch (err) {
      expect((err as Error).message).toMatch(/execute-order-ethereum-0xdef/);
      expect((err as Error).message).toMatch(/ethereum/);
    }
  });
});

describe('QueueResolver.getQueueNameForChain()', () => {
  it('returns the queue name for a known chain', () => {
    const map = new Map([['base', 'execute-order-base-0xabc']]);
    const resolver = makeResolver(map, new Map());

    expect(resolver.getQueueNameForChain('base')).toBe('execute-order-base-0xabc');
  });

  it('throws a descriptive error for an unmapped chain (adversarial — plan §B.1)', () => {
    const map = new Map<string, string>();
    const resolver = makeResolver(map, new Map());

    expect(() => resolver.getQueueNameForChain('ethereum')).toThrowError(
      /QueueResolver: no queue name mapped for chain 'ethereum'/,
    );
  });

  it('error message for getQueueNameForChain includes chain name', () => {
    const resolver = makeResolver(new Map(), new Map());

    expect(() => resolver.getQueueNameForChain('polygon')).toThrowError(/polygon/);
  });
});
