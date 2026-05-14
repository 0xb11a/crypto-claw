/**
 * wallet-harvest.schedule.ts — Cron schedule for the wallet-harvest job.
 *
 * Enqueues a `wallet-harvest` BullMQ job once per hour. The processor
 * (`HarvestProcessor` in libs/modules/wallets) fetches top-gainers from
 * Birdeye and proposes them as tracked wallets (INSERT OR IGNORE).
 *
 * Cadence: `0 * * * *` (on the hour, every hour) — matches the legacy
 * `score-wallets-bg.js` 60-min harvest gate that checked whether
 * `last_birdeye_harvest_at` was ≥ 60 min stale before calling Birdeye.
 * The cron cadence replaces the inline staleness check — the queue
 * provides natural rate control (one enqueue per tick; BullMQ deduplication
 * via `jobId` is NOT used here because hourly tokens may differ).
 *
 * DoD §E: the processor is idempotent (INSERT OR IGNORE), so enqueueing
 * twice within an hour is safe — the second run leaves the DB unchanged.
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access. REDIS_URL is resolved by the BullModule
 * forRoot registered in apps/scheduler/src/app.module.ts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { WALLET_HARVEST_QUEUE } from '@cclaw/wallets';

@Injectable()
export class WalletHarvestSchedule {
  private readonly logger = new Logger(WalletHarvestSchedule.name);

  constructor(@InjectQueue(WALLET_HARVEST_QUEUE) private readonly harvestQueue: Queue) {}

  /**
   * Enqueue a wallet-harvest job on the hour, every hour.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService. This keeps the schedule dumb and the
   * processor self-contained.
   */
  @Cron('0 * * * *')
  async enqueueHarvest(): Promise<void> {
    this.logger.log('wallet-harvest: enqueuing hourly harvest job');
    await this.harvestQueue.add('harvest', {});
  }
}
