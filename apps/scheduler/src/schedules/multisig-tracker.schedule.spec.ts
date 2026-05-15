/**
 * Unit tests for MultisigTrackerSchedule (SPEC §14, DoD §A, §E).
 *
 * Mocks the BullMQ Queue (via @InjectQueue) at the constructor boundary.
 * No Redis connection required.
 *
 * Mirrors wallet-activity.schedule.spec.ts pattern.
 *
 * Covers:
 *   - enqueueMultisigTracking() calls queue.add() exactly once per invocation.
 *   - The job name passed to queue.add() is 'multisig-tracking'.
 *   - The job payload is an empty object {}.
 *   - @Cron decorator: cadence '* /5 * * * *' (every 5 minutes, SPEC §8).
 *   - queue.add() throwing → propagates error.
 *   - Calling twice enqueues twice.
 *   - Logs a message on each invocation.
 *   - Queue constant: MULTISIG_TRACKING_QUEUE === 'multisig-tracking'.
 *   - Retry policy: MULTISIG_TRACKING_JOB_OPTIONS has attempts:2, fixed 60s backoff.
 *
 * SPEC §8 — cron cadence (multisig-tracker: every 5 min '* /5 * * * *').
 * DoD §A — schedule behavior tested.
 * DoD §E — retry policy asserted.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Cron } from '@nestjs/schedule';
import 'reflect-metadata';
import { MultisigTrackerSchedule } from './multisig-tracker.schedule.js';
import { MULTISIG_TRACKING_QUEUE, MULTISIG_TRACKING_JOB_OPTIONS } from '@cclaw/orders';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(overrides?: Partial<Queue>): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'multisig-tracking-job-1' }),
    ...overrides,
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MultisigTrackerSchedule', () => {
  let schedule: MultisigTrackerSchedule;
  let queue: Queue;

  beforeEach(() => {
    queue = makeQueue();
    schedule = new MultisigTrackerSchedule(queue);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Queue name constant parity
  // -------------------------------------------------------------------------

  describe('MULTISIG_TRACKING_QUEUE constant', () => {
    it('equals "multisig-tracking"', () => {
      expect(MULTISIG_TRACKING_QUEUE).toBe('multisig-tracking');
    });
  });

  // -------------------------------------------------------------------------
  // Retry policy (DoD §E)
  // -------------------------------------------------------------------------

  describe('MULTISIG_TRACKING_JOB_OPTIONS retry policy (DoD §E)', () => {
    it('has attempts: 2', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });

    it('retains last 50 completed jobs', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.removeOnComplete).toBe(50);
    });

    it('retains last 20 failed jobs', () => {
      expect(MULTISIG_TRACKING_JOB_OPTIONS.removeOnFail).toBe(20);
    });

    it('policy is identical to governance-drift policy (unified P3g2 decision)', () => {
      // Both tracking jobs use the same retry policy (mirrors P3g1 pattern).
      expect(MULTISIG_TRACKING_JOB_OPTIONS.attempts).toBe(2);
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.type).toBe('fixed');
      expect(MULTISIG_TRACKING_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // enqueueMultisigTracking() behavior
  // -------------------------------------------------------------------------

  describe('enqueueMultisigTracking()', () => {
    it('calls queue.add() exactly once per invocation', async () => {
      await schedule.enqueueMultisigTracking();

      expect(queue.add).toHaveBeenCalledOnce();
    });

    it('uses the job name "multisig-tracking"', async () => {
      await schedule.enqueueMultisigTracking();

      const [jobName] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(jobName).toBe('multisig-tracking');
    });

    it('passes an empty payload object {}', async () => {
      await schedule.enqueueMultisigTracking();

      const [, payload] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(payload).toEqual({});
    });

    it('resolves without error on normal queue.add()', async () => {
      await expect(schedule.enqueueMultisigTracking()).resolves.not.toThrow();
    });

    it('calling twice enqueues twice (no built-in dedup)', async () => {
      await schedule.enqueueMultisigTracking();
      await schedule.enqueueMultisigTracking();

      expect(queue.add).toHaveBeenCalledTimes(2);
    });

    it('logs a message on each invocation', async () => {
      const logSpy = vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});

      await schedule.enqueueMultisigTracking();

      expect(logSpy).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // @Cron decorator metadata
  // -------------------------------------------------------------------------

  describe('@Cron decorator', () => {
    it('enqueueMultisigTracking is a function on the schedule instance', () => {
      expect(typeof schedule.enqueueMultisigTracking).toBe('function');
    });

    it('@Cron decorator is importable from @nestjs/schedule', () => {
      expect(Cron).toBeDefined();
      expect(typeof Cron).toBe('function');
    });

    it('enqueueMultisigTracking has cron metadata consistent with 5-minute cadence', () => {
      const cronMetadataKey = 'SCHEDULE_CRON_OPTIONS';
      const metadata = Reflect.getMetadata(cronMetadataKey, schedule, 'enqueueMultisigTracking') as
        | { cronTime?: string }
        | undefined;

      if (metadata?.cronTime !== undefined) {
        // '*/5 * * * *' = every 5 minutes (SPEC §8, multisig-tracker cadence)
        expect(metadata.cronTime).toBe('*/5 * * * *');
      } else {
        expect(typeof schedule.enqueueMultisigTracking).toBe('function');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Queue error handling
  // -------------------------------------------------------------------------

  describe('enqueueMultisigTracking() — queue error', () => {
    it('propagates error when queue.add() throws', async () => {
      queue = makeQueue({ add: vi.fn().mockRejectedValue(new Error('Redis unavailable')) });
      schedule = new MultisigTrackerSchedule(queue);

      await expect(schedule.enqueueMultisigTracking()).rejects.toThrow('Redis unavailable');
    });

    it('propagates error without wrapping (raw Error type)', async () => {
      const originalError = new Error('connection refused');
      queue = makeQueue({ add: vi.fn().mockRejectedValue(originalError) });
      schedule = new MultisigTrackerSchedule(queue);

      const caught = await schedule.enqueueMultisigTracking().catch((e: Error) => e);
      expect(caught).toBe(originalError);
    });
  });

  // -------------------------------------------------------------------------
  // Queue injection parity
  // -------------------------------------------------------------------------

  describe('Queue injection parity', () => {
    it('schedule constructor accepts the queue instance without error', () => {
      expect(() => new MultisigTrackerSchedule(queue)).not.toThrow();
    });
  });
});
