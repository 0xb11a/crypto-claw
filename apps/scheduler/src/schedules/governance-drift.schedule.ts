/**
 * governance-drift.schedule.ts — Cron schedule for the governance-drift job.
 *
 * Enqueues a `governance-drift` BullMQ job once per day (midnight).
 *
 * Cadence: `0 0 * * *` (00:00 daily) — matches `sleep 86400` in
 * `entrypoint.sh:811` (DoD §I — parity).
 *
 * The processor handles the chain-loop internally; one enqueue per tick.
 * BullMQ deduplication via `jobId` is NOT used — governance checks are
 * idempotent regardless.
 *
 * DoD §E: the processor is idempotent (only `last_governance_drift_at` advances).
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { GOVERNANCE_DRIFT_QUEUE } from '@cclaw/governance';

@Injectable()
export class GovernanceDriftSchedule {
  private readonly logger = new Logger(GovernanceDriftSchedule.name);

  constructor(@InjectQueue(GOVERNANCE_DRIFT_QUEUE) private readonly governanceDriftQueue: Queue) {}

  /**
   * Enqueue a governance-drift job at midnight every day.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService.
   */
  @Cron('0 0 * * *')
  async enqueueGovernanceDrift(): Promise<void> {
    this.logger.log('governance-drift: enqueuing daily governance drift check');
    await this.governanceDriftQueue.add('governance-drift', {});
  }
}
