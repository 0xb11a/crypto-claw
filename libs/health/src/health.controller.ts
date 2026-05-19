import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { PrismaHealthIndicator } from './prisma-health.indicator.js';
import { RedisHealthIndicator } from './redis-health.indicator.js';
import { ExecutorHealthIndicator } from './executor-health.indicator.js';

/**
 * Health check controller (SPEC §11).
 *
 * /healthz — liveness (always returns 200 if the process is running)
 * /readyz  — readiness (checks Prisma + Redis + executor binary)
 *
 * P1c-i adds Redis ping and executor binary presence to /readyz.
 *
 * Both routes carry @Roles('agent', 'dashboard') as required by the
 * default-deny invariant (SPEC §4 #3). They are exempt from @Audited()
 * because they are GET-only health probes.
 *
 * Note: per SPEC §9.4, healthz/readyz are throttler-exempt.
 * @SkipThrottle({ agent: true, dashboard: true }) explicitly targets the two
 * named throttlers. @SkipThrottle() with no args defaults to { default: true }
 * in @nestjs/throttler v5, which targets a non-existent throttler and is a no-op.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
    private readonly redisIndicator: RedisHealthIndicator,
    private readonly executorIndicator: ExecutorHealthIndicator,
  ) {}

  /** Liveness probe — returns 200 if the process is alive. */
  @Get('healthz')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @SkipThrottle({ agent: true, dashboard: true })
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'ok' };
  }

  /**
   * Readiness probe — checks Prisma, Redis, and executor binary.
   *
   * Returns 503 if any check fails (BullMQ queue won't work without Redis;
   * no orders can be executed without the executor binary).
   */
  @Get('readyz')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @SkipThrottle({ agent: true, dashboard: true })
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  readiness() {
    return this.health.check([
      () => this.prismaIndicator.isHealthy('prisma'),
      () => this.redisIndicator.isHealthy('redis'),
      () => Promise.resolve(this.executorIndicator.isHealthy('executor')),
    ]);
  }
}
