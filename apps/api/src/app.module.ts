import { Module, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ConfigModule, assertConfigValid, assertNoSignerKeysInEnv } from '@cclaw/config';
import { LoggerModule } from '@cclaw/logger';
import { PrismaModule } from '@cclaw/prisma';
import { AuthModule } from '@cclaw/auth';
import { AuditModule } from '@cclaw/audit';
import { HealthModule } from '@cclaw/health';
import { PositionsModule } from '@cclaw/positions';
import { OrdersModule } from '@cclaw/orders';

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
 * P1a: wires all infrastructure modules (Prisma, Auth, Audit, Health, Throttler)
 * and domain modules (Positions, Orders).
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

    // Audit — global interceptor + AuditService + AuditRepository
    AuditModule,

    // Health — /healthz + /readyz
    HealthModule,

    // Throttler — agent 600/min, dashboard 60/min (SPEC §9.4)
    // Custom per-identity ThrottlerStorage deferred to P1b (OPEN-4)
    ThrottlerModule.forRoot([
      { name: 'agent', ttl: 60000, limit: 600 },
      { name: 'dashboard', ttl: 60000, limit: 60 },
    ]),

    // -------------------------------------------------------------------------
    // Domain modules
    // -------------------------------------------------------------------------
    PositionsModule,
    OrdersModule,
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
  ],
})
export class AppModule {}
