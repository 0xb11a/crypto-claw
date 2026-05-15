import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';
import { PrismaModule } from '@cclaw/prisma';
import { AuditModule } from '@cclaw/audit';
import { OrdersModule, resolveActiveQueueNames, buildChainQueueMap } from '@cclaw/orders';
import { ReceiptsModule } from '@cclaw/receipts';
import { WalletsModule } from '@cclaw/wallets';
import { GovernanceModule } from '@cclaw/governance';
import { createExecuteOrderProcessor } from './processors/execute-order.processor.js';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

// ---------------------------------------------------------------------------
// Per-Safe BullMQ queue enumeration (ADR-0024 addendum, P1c-ii)
//
// Resolve queue names at boot from ACTIVE_CHAINS + Safe address env vars.
// process.env access is allowed in app.module.ts (ESLint exception block).
//
// Operational note (ADR-0024 addendum): adding a new Safe to ACTIVE_CHAINS
// requires a worker restart so the new queue's Worker registers.
// See docs/runbook.md "rotate / add a Safe" for the procedure.
// ---------------------------------------------------------------------------
const activeChains = (_config.ACTIVE_CHAINS as string)
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const activeQueueNames = resolveActiveQueueNames(activeChains, process.env);
const chainQueueMap = buildChainQueueMap(activeChains, process.env);

// One processor class per queue (one per active Safe).
const processorProviders = activeQueueNames.map(createExecuteOrderProcessor);

/**
 * Root application module for apps/worker.
 *
 * P1c-i: BullMQ wired with Redis, single execute-order queue + processor.
 *
 * P1c-ii: per-Safe BullMQ queue topology (ADR-0024 addendum).
 *   - Registers one BullMQ queue per active (chain, safeAddress) pair.
 *   - Registers one ExecuteOrderProcessor per queue (concurrency=1 each).
 *   - Provides CHAIN_QUEUE_MAP token so QueueResolver (in OrdersModule) routes
 *     enqueues from the API to the correct per-Safe queue.
 *   - Cross-queue parallelism is unbounded — distinct Safes never block each other.
 */
@Module({
  imports: [
    ConfigModule,
    LoggerModule.forRoot({ logLevel: _config.LOG_LEVEL, nodeEnv: _config.NODE_ENV }),

    // Prisma — global; sets DATABASE_URL from DB_PATH before PrismaService starts
    PrismaModule.register(_config.DB_PATH),

    // BullMQ global connection — all queues share this Redis connection
    BullModule.forRoot({
      connection: {
        ...parseRedisUrl(_config.REDIS_URL),
      },
    }),

    // Per-Safe execute-order queues (ADR-0024 addendum).
    // One queue per active (chain, safeAddress) pair with retry + backoff policy.
    ...activeQueueNames.map((name) =>
      BullModule.registerQueue({
        name,
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: 100,
          removeOnFail: false,
        },
      }),
    ),

    // Global singleton queues for the P3g1 wallet pipeline are registered
    // inside WalletsModule.forWorker() below so the consumer processors'
    // `@InjectQueue` can resolve them within the same module context.
    // The retry policy (attempts:2, fixed 60s) lives next to the queue-name
    // constants in libs/modules/wallets/src/jobs/queue-names.ts.

    // Domain modules required by the processors.
    // OrdersModule.forRoot owns the CHAIN_QUEUE_MAP provider (ADR-0024 addendum, P1c-ii).
    OrdersModule.forRoot({ chainQueueMap }),
    ReceiptsModule,
    AuditModule,

    // Wallet pipeline modules (P3g1).
    // WalletsModule.forWorker() registers HarvestProcessor + ScoreWalletsProcessor,
    // their adapter modules (Birdeye, Zerion), SystemModule, AND the
    // wallet-harvest + wallet-scoring queues so processor `@InjectQueue` resolves.
    WalletsModule.forWorker(),

    // P3g2 PR-D: governance-drift + multisig-tracking processors.
    // GovernanceModule.forWorker() registers GovernanceDriftProcessor with
    // SafeTxServiceAdapter, SquadsRpcAdapter, NotificationsService, SystemModule.
    GovernanceModule.forWorker(),
    // OrdersModule.forWorker() registers MultisigTrackerProcessor with all its deps.
    // This is additive to OrdersModule.forRoot() above — forWorker() registers
    // only the multisig-tracking queue + processor, not HTTP controllers.
    OrdersModule.forWorker(),
  ],
  providers: [
    // Per-Safe processor instances (factory pattern — one class per queue name).
    // Each has concurrency=1 to prevent nonce collisions for the same Safe.
    ...processorProviders,
  ],
})
export class AppModule {}

/**
 * Parse a redis:// URL string into ioredis connection options.
 * BullMQ's forRoot `connection` field accepts ioredis ConnectionOptions.
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
