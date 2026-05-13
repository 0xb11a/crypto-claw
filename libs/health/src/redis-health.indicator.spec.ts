/**
 * Unit tests for redis-health.indicator.ts
 *
 * SPEC §11 — /readyz checks Redis ping.
 * DoD §E — health check tests for new BullMQ dependency.
 *
 * The ioredis client is mocked so tests are pure unit tests with no real Redis.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckError } from '@nestjs/terminus';

// Mock ioredis and the createClient helper so tests run without a real Redis.
vi.mock('./redis-client.js', () => ({
  createClient: vi.fn(),
}));

import { createClient } from './redis-client.js';
import { RedisHealthIndicator } from './redis-health.indicator.js';

function makeConfigService(redisUrl = 'redis://localhost:6379') {
  // ADR-0026: per-field get mock. Returns the string value for 'REDIS_URL'.
  return {
    get: vi.fn((key: string) => {
      if (key === 'REDIS_URL') return redisUrl;
      return undefined;
    }),
  };
}

interface MockRedisClient {
  ping: ReturnType<typeof vi.fn>;
  quit: ReturnType<typeof vi.fn>;
}

function makeRedisClient(pingResult: 'PONG' | Error): MockRedisClient {
  const client: MockRedisClient = {
    ping: vi.fn(),
    quit: vi.fn().mockResolvedValue(undefined),
  };
  if (pingResult instanceof Error) {
    client.ping.mockRejectedValue(pingResult);
  } else {
    client.ping.mockResolvedValue(pingResult);
  }
  return client;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RedisHealthIndicator.isHealthy()', () => {
  it('returns up when Redis ping succeeds', async () => {
    const mockClient = makeRedisClient('PONG');
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    const result = await indicator.isHealthy('redis');

    expect(result['redis'].status).toBe('up');
  });

  it('throws HealthCheckError when Redis ping fails', async () => {
    const mockClient = makeRedisClient(new Error('Connection refused'));
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    await expect(indicator.isHealthy('redis')).rejects.toThrow(HealthCheckError);
  });

  it('closes the Redis client after a successful ping (no connection leak)', async () => {
    const mockClient = makeRedisClient('PONG');
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    await indicator.isHealthy('redis');

    expect(mockClient.quit).toHaveBeenCalledOnce();
  });

  it('closes the Redis client even after a ping failure (no connection leak)', async () => {
    const mockClient = makeRedisClient(new Error('Connection refused'));
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    await expect(indicator.isHealthy('redis')).rejects.toThrow(HealthCheckError);

    expect(mockClient.quit).toHaveBeenCalledOnce();
  });

  it('includes error message in HealthCheckError detail', async () => {
    const mockClient = makeRedisClient(new Error('ECONNREFUSED 127.0.0.1:6379'));
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    try {
      await indicator.isHealthy('redis');
      expect.fail('Expected HealthCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(HealthCheckError);
      expect((err as HealthCheckError).message).toContain('Redis ping failed');
    }
  });

  it('passes the configured REDIS_URL to createClient', async () => {
    const mockClient = makeRedisClient('PONG');
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(mockClient);

    const indicator = new RedisHealthIndicator(makeConfigService('redis://redis.internal:6380') as never);
    await indicator.isHealthy('redis');

    expect(createClient).toHaveBeenCalledWith('redis://redis.internal:6380');
  });

  it('gracefully ignores quit() errors (disconnect race)', async () => {
    const client = {
      ping: vi.fn().mockResolvedValue('PONG'),
      quit: vi.fn().mockRejectedValue(new Error('already disconnected')),
    };
    (createClient as ReturnType<typeof vi.fn>).mockReturnValue(client);

    const indicator = new RedisHealthIndicator(makeConfigService() as never);
    // Must NOT throw even though quit() rejects
    const result = await indicator.isHealthy('redis');
    expect(result['redis'].status).toBe('up');
  });
});
