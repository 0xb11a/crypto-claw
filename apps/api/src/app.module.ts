import { Module, ValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';
import { PrismaModule } from '@cclaw/prisma';
import { AuthModule, AppThrottlerModule, AppThrottlerGuard } from '@cclaw/auth';
import { AuditModule } from '@cclaw/audit';
import { HealthModule } from '@cclaw/health';
import { PositionsModule } from '@cclaw/positions';
import { OrdersModule, resolveActiveQueueNames, buildChainQueueMap } from '@cclaw/orders';
import { ReceiptsModule } from '@cclaw/receipts';
import { AlertsModule } from '@cclaw/alerts';
import { HeartbeatModule } from '@cclaw/heartbeat';
import { WalletsModule } from '@cclaw/wallets';
import { LiquidityModule } from '@cclaw/liquidity';
import { WatchlistModule } from '@cclaw/watchlist';
import { AgentLogsModule } from '@cclaw/agent-logs';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
// process.env is allowed here — this file is in the config/bootstrap exception block
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

// ---------------------------------------------------------------------------
// Per-Safe BullMQ queue enumeration (ADR-0024 addendum, P1c-ii)
//
// Resolve the queue names for all active (chain, safeAddress) pairs at boot.
// process.env access is allowed in app.module.ts (ESLint exception block).
// The resulting queue names are used to:
//   1. Register BullMQ queues so OrdersService can enqueue jobs.
//   2. Provide the CHAIN_QUEUE_MAP token so QueueResolver can route by chain.
// ---------------------------------------------------------------------------
const activeChains = (_config.ACTIVE_CHAINS as string)
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean);

const activeQueueNames = resolveActiveQueueNames(activeChains, process.env);
const chainQueueMap = buildChainQueueMap(activeChains, process.env);

/**
 * Root application module for apps/api.
 *
 * P1c-i: BullMQ wired with Redis connection from config, execute-order
 * queue registered, OrdersModule imports queue registration.
 *
 * P1c-ii: per-Safe BullMQ queue topology (ADR-0024 addendum).
 * Registers one BullMQ queue per active (chain, safeAddress) pair.
 * Provides CHAIN_QUEUE_MAP token so QueueResolver routes enqueues correctly.
 */
@Module({
  imports: [
    // -------------------------------------------------------------------------
    // Infrastructure
    // -------------------------------------------------------------------------
    ConfigModule,
    LoggerModule.forRoot({ logLevel: _config.LOG_LEVEL, nodeEnv: _config.NODE_ENV }),

    // Prisma — global; sets DATABASE_URL from DB_PATH before PrismaService starts
    PrismaModule.register(_config.DB_PATH),

    // Auth — global guards: BearerAuthGuard + RolesGuard + IdentityGuard (no-op shim)
    AuthModule,

    // Audit — global interceptor + AuditService + AuditRepository + AuditController (P1b)
    AuditModule,

    // Health — /healthz + /readyz (both @SkipThrottle() per SPEC §9.4)
    HealthModule,

    // Throttler — agent 600/min, dashboard 60/min, per-identity via AppThrottlerGuard (SPEC §9.4, ADR-0021)
    AppThrottlerModule.forRoot(),

    // BullMQ global connection (P1c-i, SPEC §8, ADR-0004).
    // The api enqueues execute-order jobs onto Redis when OrdersService.execute()
    // runs in real mode. Without forRoot(), enqueues default to localhost:6379.
    BullModule.forRoot({
      connection: { url: _config.REDIS_URL },
    }),

    // Per-Safe execute-order queues (ADR-0024 addendum, P1c-ii).
    // One queue per active (chain, safeAddress) pair. The worker registers
    // one Worker per queue with concurrency=1 to prevent nonce collisions.
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

    // -------------------------------------------------------------------------
    // Domain modules
    // -------------------------------------------------------------------------
    PositionsModule,
    // OrdersModule.forRoot owns the CHAIN_QUEUE_MAP provider (ADR-0024 addendum, P1c-ii).
    // Providing it here (at AppModule level) would fail because NestJS does not
    // propagate non-exported providers across module boundaries.
    OrdersModule.forRoot({ chainQueueMap }),
    ReceiptsModule,
    AlertsModule,
    HeartbeatModule,
    // P2 group 1: smart-money pipeline
    WalletsModule,
    LiquidityModule,
    WatchlistModule,
    // P2 group 2: agent log tables
    AgentLogsModule,
  ],
  providers: [
    // Global ValidationPipe (SPEC §9.3)
    {
      provide: APP_PIPE,
      useValue: new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    },
    // AppThrottlerGuard — registered AFTER BearerAuthGuard (which is in AuthModule's APP_GUARD list)
    // so that req.user.identity is populated by the time getTracker() runs (ADR-0021).
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
  ],
})
export class AppModule {}
