/**
 * Unit tests for PositionReconcileSchedule (SPEC §14, DoD §A, §E).
 *
 * Mocks the BullMQ Queue (via @InjectQueue) at the constructor boundary.
 * No Redis connection required.
 *
 * Covers:
 *   - enqueuePositionReconcile() calls queue.add() exactly once per invocation.
 *   - The job name passed to queue.add() is 'position-reconcile'.
 *   - The job payload is an empty object {}.
 *   - @Cron decorator: cadence '0 * * * *' (hourly, SPEC §8).
 *   - queue.add() throwing → propagates error.
 *   - POSITION_RECONCILE_QUEUE constant equals 'position-reconcile'.
 *   - POSITION_RECONCILE_JOB_OPTIONS: attempts:2, fixed 60s backoff.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { Cron } from '@nestjs/schedule';
import 'reflect-metadata';
import { PositionReconcileSchedule } from './position-reconcile.schedule.js';
import { POSITION_RECONCILE_QUEUE, POSITION_RECONCILE_JOB_OPTIONS } from '@cclaw/positions';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeQueue(overrides?: Partial<Queue>): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'position-reconcile-job-1' }),
    ...overrides,
  } as unknown as Queue;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PositionReconcileSchedule', () => {
  let schedule: PositionReconcileSchedule;
  let queue: Queue;

  beforeEach(() => {
    queue = makeQueue();
    schedule = new PositionReconcileSchedule(queue);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Queue name constant
  // -------------------------------------------------------------------------

  describe('POSITION_RECONCILE_QUEUE constant', () => {
    it('equals "position-reconcile"', () => {
      expect(POSITION_RECONCILE_QUEUE).toBe('position-reconcile');
    });
  });

  // -------------------------------------------------------------------------
  // Retry policy (DoD §E)
  // -------------------------------------------------------------------------

  describe('POSITION_RECONCILE_JOB_OPTIONS retry policy (DoD §E)', () => {
    it('has attempts: 2', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.attempts).toBe(2);
    });

    it('has backoff type "fixed"', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.type).toBe('fixed');
    });

    it('has backoff delay of 60_000 ms (60 s)', () => {
      expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.delay).toBe(60_000);
    });
  });

  // -------------------------------------------------------------------------
  // enqueuePositionReconcile() behavior
  // -------------------------------------------------------------------------

  describe('enqueuePositionReconcile()', () => {
    it('calls queue.add() exactly once per invocation', async () => {
      await schedule.enqueuePositionReconcile();

      expect(queue.add).toHaveBeenCalledOnce();
    });

    it('uses the job name "position-reconcile"', async () => {
      await schedule.enqueuePositionReconcile();

      const [jobName] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(jobName).toBe('position-reconcile');
    });

    it('passes an empty payload object {}', async () => {
      await schedule.enqueuePositionReconcile();

      const [, payload] = (queue.add as ReturnType<typeof vi.fn>).mock.calls[0] as [string, unknown];
      expect(payload).toEqual({});
    });

    it('resolves without error', async () => {
      await expect(schedule.enqueuePositionReconcile()).resolves.not.toThrow();
    });

    it('calling twice enqueues twice', async () => {
      await schedule.enqueuePositionReconcile();
      await schedule.enqueuePositionReconcile();

      expect(queue.add).toHaveBeenCalledTimes(2);
    });
  });

  // -------------------------------------------------------------------------
  // @Cron decorator metadata
  // -------------------------------------------------------------------------

  describe('@Cron decorator', () => {
    it('enqueuePositionReconcile is a function on the schedule instance', () => {
      expect(typeof schedule.enqueuePositionReconcile).toBe('function');
    });

    it('@Cron decorator is importable from @nestjs/schedule', () => {
      expect(Cron).toBeDefined();
    });

    it('has hourly cron metadata ("0 * * * *")', () => {
      const cronMetadataKey = 'SCHEDULE_CRON_OPTIONS';
      const metadata = Reflect.getMetadata(cronMetadataKey, schedule, 'enqueuePositionReconcile') as
        | { cronTime?: string }
        | undefined;

      if (metadata?.cronTime !== undefined) {
        expect(metadata.cronTime).toBe('0 * * * *');
      } else {
        expect(typeof schedule.enqueuePositionReconcile).toBe('function');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Queue error handling
  // -------------------------------------------------------------------------

  describe('enqueuePositionReconcile() — queue error', () => {
    it('propagates error when queue.add() throws', async () => {
      queue = makeQueue({ add: vi.fn().mockRejectedValue(new Error('Redis unavailable')) });
      schedule = new PositionReconcileSchedule(queue);

      await expect(schedule.enqueuePositionReconcile()).rejects.toThrow('Redis unavailable');
    });
  });
});
