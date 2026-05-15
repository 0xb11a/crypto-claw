/**
 * multisig-tracker.schedule.ts — Cron schedule for the multisig-tracking job.
 *
 * Enqueues a `multisig-tracking` BullMQ job every 5 minutes.
 *
 * Cadence: `*\/5 * * * *` (every 5 minutes) — matches the 5-minute loop
 * in `entrypoint.sh:872` (DoD §I — parity).
 *
 * The processor handles all queued receipts in one cycle. One enqueue per tick.
 *
 * DoD §E: the processor is idempotent (markExecuted/markReverted are
 * no-ops if already in target state; only `last_multisig_tracker_at` advances).
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { MULTISIG_TRACKING_QUEUE } from '@cclaw/orders';

@Injectable()
export class MultisigTrackerSchedule {
  private readonly logger = new Logger(MultisigTrackerSchedule.name);

  constructor(@InjectQueue(MULTISIG_TRACKING_QUEUE) private readonly multisigTrackingQueue: Queue) {}

  /**
   * Enqueue a multisig-tracking job every 5 minutes.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService.
   */
  @Cron('*/5 * * * *')
  async enqueueMultisigTracking(): Promise<void> {
    this.logger.log('multisig-tracker: enqueuing 5-min check');
    await this.multisigTrackingQueue.add('multisig-tracking', {});
  }
}
