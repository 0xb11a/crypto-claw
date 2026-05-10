import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { PrismaService } from '@cclaw/prisma';

/**
 * Prisma health indicator for /readyz (SPEC §11).
 *
 * Pings the SQLite database via $queryRaw to confirm connectivity.
 */
@Injectable()
export class PrismaHealthIndicator extends HealthIndicator {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return this.getStatus(key, true);
    } catch (err) {
      throw new HealthCheckError('Prisma health check failed', this.getStatus(key, false, { error: String(err) }));
    }
  }
}
