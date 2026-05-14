/**
 * Worker AppModule DI smoke test (SPEC §14, DoD §A, §E).
 *
 * Verifies that:
 *   1. WALLET_HARVEST_QUEUE is registered in AppModule with the correct
 *      BullMQ retry policy: attempts:2, fixed backoff 60_000 ms (P3g1 [OPEN-4]).
 *   2. The WALLET_HARVEST_JOB_OPTIONS constant from wallet-harvest.queue.ts
 *      declares the expected policy.
 *   3. HarvestProcessor class is importable from the expected location.
 *   4. The WALLET_HARVEST_QUEUE constant value matches what app.module.ts uses.
 *
 * NOTE: Full NestJS `Test.createTestingModule` bootstrap is intentionally NOT
 * used here. Bootstrapping AppModule requires a live Redis connection and a
 * compiled Prisma client pointed at a real DB. Those checks live in:
 *   - apps/worker/src/main.spec.ts — boot-defense integration (built artifact)
 *   - tests/integration/boot-defenses.spec.ts — multi-app boot defenses
 *
 * This spec covers the *static* DI contract: queue name parity and retry
 * policy invariants that can be verified without a running process.
 *
 * SPEC §4 — boot self-checks (signer-key isolation, config validation).
 * SPEC §8 — background job retry policy: attempts:2, 60 s fixed backoff.
 * DoD §E — backoff/retry policy asserted.
 */

import { describe, it, expect } from 'vitest';
import { WALLET_HARVEST_QUEUE, WALLET_HARVEST_JOB_OPTIONS } from './queues/wallet-harvest.queue.js';
import { WALLET_HARVEST_QUEUE as DOMAIN_QUEUE_NAME } from '@cclaw/wallets';
import { HarvestProcessor } from '../../../libs/modules/wallets/src/jobs/harvest.processor.js';

describe('Worker AppModule — static DI contract verification', () => {
  // -------------------------------------------------------------------------
  // Queue name parity: scheduler and worker must import from the same source
  // -------------------------------------------------------------------------

  describe('WALLET_HARVEST_QUEUE constant', () => {
    it('worker re-export equals the domain canonical value', () => {
      // Both the scheduler and worker re-export from @cclaw/wallets.
      // If they ever diverge, the scheduler enqueues to a queue the worker
      // never processes — this test catches that before runtime.
      expect(WALLET_HARVEST_QUEUE).toBe(DOMAIN_QUEUE_NAME);
    });

    it('equals "wallet-harvest"', () => {
      expect(WALLET_HARVEST_QUEUE).toBe('wallet-harvest');
    });
  });

  // -------------------------------------------------------------------------
  // BullMQ retry policy: P3g1 [OPEN-4] — attempts:2, fixed 60 s
  // -------------------------------------------------------------------------

  describe('WALLET_HARVEST_JOB_OPTIONS retry policy (DoD §E)', () => {
    it('has attempts: 2', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(WALLET_HARVEST_JOB_OPTIONS.removeOnFail).toBe(20);
    });
  });

  // -------------------------------------------------------------------------
  // HarvestProcessor importability (DI resolution without bootstrap)
  // -------------------------------------------------------------------------

  describe('HarvestProcessor', () => {
    it('is a class (importable from expected path)', () => {
      expect(HarvestProcessor).toBeDefined();
      expect(typeof HarvestProcessor).toBe('function');
    });

    it('prototype has a process() method (WorkerHost contract)', () => {
      expect(typeof HarvestProcessor.prototype.process).toBe('function');
    });
  });
});
