/**
 * redis-health.indicator.ts — Terminus health indicator for Redis (BullMQ connection).
 *
 * Pings Redis by creating a temporary ioredis connection and calling PING.
 * The connection is created fresh each health check and closed immediately
 * to avoid holding persistent connections in the health layer.
 *
 * SPEC §11 — /readyz checks Redis ping.
 * @see DoD §E — health check updated because execute-order queue liveness affects readiness.
 * ADR-0026: uses per-field configService.get<T>('FIELD') — not bare-key get<AppConfig>('').
 */
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { ConfigService } from '@nestjs/config';
import { createClient } from './redis-client.js';

/**
 * Health indicator that pings Redis.
 *
 * Uses a lightweight connect+PING+disconnect per check.
 * Connection errors → 503 (not ready).
 */
@Injectable()
export class RedisHealthIndicator extends HealthIndicator {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  /**
   * Ping Redis and return a health indicator result.
   *
   * @param key - The key for this indicator in the health check response.
   * @returns HealthIndicatorResult — { [key]: { status: 'up' | 'down' } }
   * @throws HealthCheckError on connection failure.
   */
  async isHealthy(key: string): Promise<HealthIndicatorResult> {
    // ADR-0026: per-field get — not bare-key get<AppConfig>('')
    const redisUrl = this.configService.get<string>('REDIS_URL') ?? 'redis://localhost:6379';

    try {
      await pingRedis(redisUrl);
      return this.getStatus(key, true);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new HealthCheckError(`Redis ping failed: ${msg}`, this.getStatus(key, false, { error: msg }));
    }
  }
}

/**
 * Open a transient Redis connection, send PING, close.
 *
 * We don't use the BullMQ queue connection directly to avoid coupling
 * the health check to BullMQ internals. A raw ioredis ping is cheaper.
 *
 * @param redisUrl - redis:// URL from config.
 */
async function pingRedis(redisUrl: string): Promise<void> {
  const client = createClient(redisUrl);
  try {
    await client.ping();
  } finally {
    await client.quit().catch(() => {
      // ignore quit errors — we already got the answer we needed
    });
  }
}
