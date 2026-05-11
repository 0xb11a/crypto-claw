import { Module } from '@nestjs/common';
import type { ExecutionContext } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

/**
 * AppThrottlerModule — wraps ThrottlerModule with named per-role throttlers.
 *
 * Named throttlers:
 *   - `agent`: 600 requests per 60 seconds (SPEC §9.4)
 *   - `dashboard`: 60 requests per 60 seconds (SPEC §9.4)
 *
 * Each throttler carries a `skipIf` callback that activates the throttler ONLY
 * for the matching role. Without skipIf, @nestjs/throttler v5 applies ALL named
 * throttlers to every request, so an agent would be capped at the dashboard
 * limit of 60/min instead of 600/min (SPEC §9.4 violation).
 *
 * Unauthenticated requests (req.user absent) satisfy neither role check — both
 * throttlers skip them. They fall through to BearerAuthGuard, which 401s them.
 *
 * The actual per-identity throttle key is set by AppThrottlerGuard.getTracker().
 * This module is imported once in AppModule — it replaces the bare
 * ThrottlerModule.forRoot([...]) call from P1a.
 *
 * Cross-ref: ADR-0021 (in-memory storage choice).
 */
@Module({})
export class AppThrottlerModule {
  static forRoot() {
    return ThrottlerModule.forRoot([
      {
        name: 'agent',
        ttl: 60_000,
        limit: 600,
        /**
         * Skip the agent throttler when the caller is NOT an agent.
         * This ensures the 600/min bucket only fires for agent-role identities.
         */
        skipIf: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ user?: { role?: string } }>();
          return req.user?.role !== 'agent';
        },
      },
      {
        name: 'dashboard',
        ttl: 60_000,
        limit: 60,
        /**
         * Skip the dashboard throttler when the caller is NOT a dashboard.
         * This ensures the 60/min bucket only fires for dashboard-role identities.
         */
        skipIf: (ctx: ExecutionContext) => {
          const req = ctx.switchToHttp().getRequest<{ user?: { role?: string } }>();
          return req.user?.role !== 'dashboard';
        },
      },
    ]);
  }
}
