import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';
import { WalletHarvestSchedule } from './schedules/wallet-harvest.schedule.js';
import { WalletScoringSchedule } from './schedules/wallet-scoring.schedule.js';
import { WalletActivitySchedule } from './schedules/wallet-activity.schedule.js';
import { GovernanceDriftSchedule } from './schedules/governance-drift.schedule.js';
import { MultisigTrackerSchedule } from './schedules/multisig-tracker.schedule.js';
import { WALLET_HARVEST_QUEUE, WALLET_SCORING_QUEUE, WALLET_ACTIVITY_QUEUE } from '@cclaw/wallets';
import { GOVERNANCE_DRIFT_QUEUE } from '@cclaw/governance';
import { MULTISIG_TRACKING_QUEUE } from '@cclaw/orders';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

/**
 * Root application module for apps/scheduler.
 *
 * P3g1 (first time @nestjs/schedule lands):
 *   - `ScheduleModule.forRoot()` activates the NestJS cron runner.
 *   - `BullModule.forRoot()` connects to Redis so the scheduler can enqueue
 *     jobs onto the same BullMQ queues the worker processes.
 *   - `BullModule.registerQueue(WALLET_HARVEST_QUEUE)` registers the queue
 *     handle so `@InjectQueue(WALLET_HARVEST_QUEUE)` resolves in schedule
 *     providers. The retry/backoff policy lives in apps/worker where it is
 *     canonical; the scheduler only needs a producer handle.
 *   - `WalletHarvestSchedule` provides the `@Cron('0 * * * *')` enqueuer.
 *   - `WalletScoringSchedule` provides the `@Cron('*\/10 * * * *')` enqueuer (PR-B).
 *
 * Queue registration here is a *producer-only* registration — no Worker /
 * processor is created in the scheduler process. The worker owns processing.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({ logLevel: _config.LOG_LEVEL, nodeEnv: _config.NODE_ENV }),

    // Activate NestJS cron scheduler (first registration in P3g1).
    ScheduleModule.forRoot(),

    // BullMQ global Redis connection — mirrors apps/worker so both processes
    // reach the same Redis instance and therefore the same queue.
    BullModule.forRoot({
      connection: {
        ...parseRedisUrl(_config.REDIS_URL),
      },
    }),

    // Register producer handles for wallet pipeline queues.
    // No defaultJobOptions needed on the producer side — job options are set
    // by the enqueuer at add() call time (or inherited from the consumer-side
    // defaultJobOptions registered in apps/worker).
    BullModule.registerQueue({ name: WALLET_HARVEST_QUEUE }),
    // PR-B: wallet-scoring queue (producer-only handle; processor lives in worker).
    BullModule.registerQueue({ name: WALLET_SCORING_QUEUE }),
    // PR-C: wallet-activity queue (producer-only handle; processor lives in worker).
    BullModule.registerQueue({ name: WALLET_ACTIVITY_QUEUE }),

    // P3g2 PR-D: producer-only handles for governance-drift and multisig-tracking.
    BullModule.registerQueue({ name: GOVERNANCE_DRIFT_QUEUE }),
    BullModule.registerQueue({ name: MULTISIG_TRACKING_QUEUE }),
  ],
  providers: [
    WalletHarvestSchedule,
    WalletScoringSchedule,
    WalletActivitySchedule,
    // P3g2 PR-D schedules.
    GovernanceDriftSchedule,
    MultisigTrackerSchedule,
  ],
})
export class AppModule {}

/**
 * Parse a redis:// URL string into ioredis connection options.
 * Mirrors the same helper in apps/worker/src/app.module.ts.
 * TODO: extract to a shared utility in libs/config or libs/prisma in a
 * future cleanup PR to avoid duplication.
 */
function parseRedisUrl(url: string): { host: string; port: number; password?: string } {
  try {
    const parsed = new URL(url);
    return {
      host: parsed.hostname || 'localhost',
      port: parseInt(parsed.port || '6379', 10),
      ...(parsed.password ? { password: parsed.password } : {}),
    };
  } catch {
    // Fallback: localhost defaults
    return { host: 'localhost', port: 6379 };
  }
}
