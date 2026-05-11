import { Module } from '@nestjs/common';
import { ThrottlerModule } from '@nestjs/throttler';

/**
 * AppThrottlerModule — wraps ThrottlerModule with named per-role throttlers.
 *
 * Named throttlers:
 *   - `agent`: 600 requests per 60 seconds (SPEC §9.4)
 *   - `dashboard`: 60 requests per 60 seconds (SPEC §9.4)
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
      { name: 'agent', ttl: 60_000, limit: 600 },
      { name: 'dashboard', ttl: 60_000, limit: 60 },
    ]);
  }
}
