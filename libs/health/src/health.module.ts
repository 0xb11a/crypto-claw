import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';
import { PrismaHealthIndicator } from './prisma-health.indicator.js';
import { RedisHealthIndicator } from './redis-health.indicator.js';
import { ExecutorHealthIndicator } from './executor-health.indicator.js';

/**
 * Health module — exposes /healthz and /readyz endpoints (SPEC §11).
 *
 * P1c-i: /readyz extended with Redis ping and executor binary presence check.
 *
 * Import once in AppModule.
 */
@Module({
  imports: [TerminusModule],
  controllers: [HealthController],
  providers: [PrismaHealthIndicator, RedisHealthIndicator, ExecutorHealthIndicator],
})
export class HealthModule {}
