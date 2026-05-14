/**
 * wallet-activity.schedule.ts — Cron schedule for the wallet-activity job.
 *
 * Enqueues a `wallet-activity` BullMQ job every 30 minutes. The processor
 * (`ActivityWalletsProcessor` in libs/modules/wallets) polls a rotating slice
 * of smart_money wallets for recent on-chain swaps, extracts swap signals, and
 * writes per-swap rows to `smart_money_signals`.
 *
 * Cadence: `* /30 * * * *` (every 30 minutes) — matches the legacy
 * `activity-wallets-bg.js` invocation cadence (`sleep 1800`) in `entrypoint.sh`.
 *
 * DoD §E: the processor is idempotent (insertSignal uses INSERT OR IGNORE
 * semantics via upsert), so enqueueing twice within 30 minutes is safe —
 * the second run leaves the DB unchanged (no new signal rows; only
 * `last_activity_wallets_bg_at` advances).
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access. REDIS_URL is resolved by the BullModule
 * forRoot registered in apps/scheduler/src/app.module.ts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { WALLET_ACTIVITY_QUEUE } from '@cclaw/wallets';

@Injectable()
export class WalletActivitySchedule {
  private readonly logger = new Logger(WalletActivitySchedule.name);

  constructor(@InjectQueue(WALLET_ACTIVITY_QUEUE) private readonly activityQueue: Queue) {}

  /**
   * Enqueue a wallet-activity job every 30 minutes.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService. This keeps the schedule dumb and the
   * processor self-contained.
   */
  @Cron('*/30 * * * *')
  async enqueueActivity(): Promise<void> {
    this.logger.log('wallet-activity: enqueuing 30-minute activity poll job');
    await this.activityQueue.add('activity-wallets', {});
  }
}
