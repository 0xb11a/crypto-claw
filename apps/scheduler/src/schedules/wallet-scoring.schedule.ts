/**
 * wallet-scoring.schedule.ts — Cron schedule for the wallet-scoring job.
 *
 * Enqueues a `wallet-scoring` BullMQ job every 10 minutes. The processor
 * (`ScoreWalletsProcessor` in libs/modules/wallets) picks up unscored wallets
 * from `tracked_wallets`, calls Birdeye + Zerion APIs in parallel, scores
 * each wallet, and writes the result back.
 *
 * Cadence: `* /10 * * * *` (every 10 minutes) — matches the legacy
 * `score-wallets-bg.js` invocation cadence (`sleep 600`) in `entrypoint.sh`.
 *
 * DoD §E: the processor is idempotent (updateScore is safe to run twice),
 * so enqueueing twice within 10 minutes is safe — the second run leaves the
 * DB unchanged (scores already written).
 *
 * Config access (ADR-0026): only `@InjectQueue` token is used here; no
 * direct configService access. REDIS_URL is resolved by the BullModule
 * forRoot registered in apps/scheduler/src/app.module.ts.
 */
import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { WALLET_SCORING_QUEUE } from '@cclaw/wallets';

@Injectable()
export class WalletScoringSchedule {
  private readonly logger = new Logger(WalletScoringSchedule.name);

  constructor(@InjectQueue(WALLET_SCORING_QUEUE) private readonly scoringQueue: Queue) {}

  /**
   * Enqueue a wallet-scoring job every 10 minutes.
   *
   * The job has no payload — all configuration is resolved inside the
   * processor via ConfigService. This keeps the schedule dumb and the
   * processor self-contained.
   */
  @Cron('*/10 * * * *')
  async enqueueScoring(): Promise<void> {
    this.logger.log('wallet-scoring: enqueuing 10-minute scoring job');
    await this.scoringQueue.add('score-wallets', {});
  }
}
