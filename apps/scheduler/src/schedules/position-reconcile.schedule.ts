/**
 * position-reconcile.schedule.ts — Cron schedule for the position-reconcile job.
 *
 * Enqueues a `position-reconcile` BullMQ job once per hour.
 *
 * Cadence: `0 * * * *` (hourly) — matches `sleep 3600` in
 * `entrypoint.sh:run_position_reconcile_loop` (DoD §I — parity).
 *
 * The processor handles the per-position loop internally; one enqueue per tick.
 *
 * DoD §E: the processor is idempotent (only `last_position_reconcile_at` advances,
 * and the `shouldAppendDriftMarker` guard prevents duplicate drift notes within
 * the same UTC hour).
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { POSITION_RECONCILE_QUEUE } from '@cclaw/positions';

@Injectable()
export class PositionReconcileSchedule {
  private readonly logger = new Logger(PositionReconcileSchedule.name);

  constructor(@InjectQueue(POSITION_RECONCILE_QUEUE) private readonly positionReconcileQueue: Queue) {}

  /**
   * Enqueue a position-reconcile job every hour.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService.
   */
  @Cron('0 * * * *')
  async enqueuePositionReconcile(): Promise<void> {
    this.logger.log('position-reconcile: enqueuing hourly position reconcile check');
    await this.positionReconcileQueue.add('position-reconcile', {});
  }
}
