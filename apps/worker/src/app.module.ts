import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';
import { PrismaModule } from '@cclaw/prisma';
import { AuditModule } from '@cclaw/audit';
import { OrdersModule } from '@cclaw/orders';
import { ReceiptsModule } from '@cclaw/receipts';
import { EXECUTE_ORDER_QUEUE } from './queues/execute-order.queue.js';
import { ExecuteOrderProcessor } from './processors/execute-order.processor.js';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

/**
 * Root application module for apps/worker.
 *
 * P1c-i: BullMQ wired with Redis connection from config, execute-order
 * queue registered, ExecuteOrderProcessor registered.
 *
 * Concurrency = 1 globally (ADR-0024). P1c-ii upgrades to per-Safe groups
 * when the real Safe/Squads SDK lands.
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

    // Register the execute-order queue with retry + backoff policy (ADR-0024)
    BullModule.registerQueue({
      name: EXECUTE_ORDER_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: 100,
        removeOnFail: false,
      },
    }),

    // Domain modules required by the processor
    OrdersModule,
    ReceiptsModule,
    AuditModule,
  ],
  providers: [
    // Processor must be in providers for NestJS DI + BullMQ @Processor decorator
    ExecuteOrderProcessor,
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
