import { Controller, Get } from '@nestjs/common';
import { SkipThrottle } from '@nestjs/throttler';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { PrismaHealthIndicator } from './prisma-health.indicator.js';

/**
 * Health check controller (SPEC §11).
 *
 * /healthz — liveness (always returns 200 if the process is running)
 * /readyz  — readiness (checks Prisma connectivity)
 *
 * Both routes carry @Roles('agent', 'dashboard') as required by the
 * default-deny invariant (SPEC §4 #3). They are exempt from @Audited()
 * because they are GET-only health probes.
 *
 * Note: per SPEC §9.4, healthz/readyz are throttler-exempt. The ThrottlerGuard
 * is applied globally but these routes can be overridden with @SkipThrottle()
 * if/when the custom ThrottlerStorage is implemented in P1b.
 */
@ApiTags('health')
@Controller()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly prismaIndicator: PrismaHealthIndicator,
  ) {}

  /** Liveness probe — returns 200 if the process is alive. */
  @Get('healthz')
  @Roles('agent', 'dashboard')
  @SkipThrottle()
  @ApiOperation({ summary: 'Liveness probe' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'ok' };
  }

  /** Readiness probe — checks Prisma connectivity. */
  @Get('readyz')
  @Roles('agent', 'dashboard')
  @SkipThrottle()
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  readiness() {
    return this.health.check([() => this.prismaIndicator.isHealthy('prisma')]);
  }
}
