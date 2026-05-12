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
import { OrdersModule } from '@cclaw/orders';
import { ReceiptsModule } from '@cclaw/receipts';
import { AlertsModule } from '@cclaw/alerts';
import { HeartbeatModule } from '@cclaw/heartbeat';

// Boot self-checks run at module-import time so they fire before NestFactory
// touches anything. Order matches main.ts (SPEC §4 #4 then §4 #6): signer-key
// isolation first, then config validation. Both are idempotent — main.ts
// re-runs them as a defensive double-check; the second call is a no-op if the
// first passed and never reached if the first throws.
// process.env is allowed here — this file is in the config/bootstrap exception block
assertNoSignerKeysInEnv(process.env);
const _config = assertConfigValid(process.env);

/**
 * Root application module for apps/api.
 *
 * P1b: wires receipts, alerts, heartbeat modules; replaces plain ThrottlerModule
 * with AppThrottlerModule (per-identity rate limiting); adds AppThrottlerGuard
 * AFTER BearerAuthGuard so req.user is populated before throttle tracking runs.
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

    // BullMQ connection (P1c-i, SPEC §8, ADR-0004). The api enqueues `execute-order`
    // jobs onto Redis when OrdersService.execute() runs in real mode (non-paper).
    // Without this forRoot(), enqueues default to localhost:6379 — works in dev/CI
    // but silently breaks any topology with a non-localhost Redis. The worker has
    // its own forRoot at apps/worker/src/app.module.ts; both must agree on connection.
    BullModule.forRoot({
      connection: { url: _config.REDIS_URL },
    }),

    // -------------------------------------------------------------------------
    // Domain modules
    // -------------------------------------------------------------------------
    PositionsModule,
    OrdersModule,
    ReceiptsModule,
    AlertsModule,
    HeartbeatModule,
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
    // Guard order in NestJS: providers with APP_GUARD token are applied in registration order.
    // AuthModule registers BearerAuthGuard first; AppThrottlerGuard registers here after AuthModule.
    {
      provide: APP_GUARD,
      useClass: AppThrottlerGuard,
    },
  ],
})
export class AppModule {}
