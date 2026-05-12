/**
 * Unit tests for redis-client.ts
 *
 * Tests that createClient() returns a configured ioredis instance.
 * The ioredis Redis constructor is mocked so no real connection is made.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

// Mock ioredis so we don't attempt real connections
vi.mock('ioredis', () => {
  const MockRedis = vi.fn().mockImplementation(function (url: string, opts: Record<string, unknown>) {
    return { _url: url, _opts: opts };
  });
  return { default: MockRedis };
});

import { createClient } from './redis-client.js';
import Redis from 'ioredis';

afterEach(() => {
  vi.clearAllMocks();
});

describe('createClient()', () => {
  it('returns a Redis instance', () => {
    const client = createClient('redis://localhost:6379');
    expect(client).toBeDefined();
  });

  it('passes the redis URL to the ioredis constructor', () => {
    createClient('redis://my-redis:6380');
    expect(Redis as unknown as ReturnType<typeof vi.fn>).toHaveBeenCalledWith(
      'redis://my-redis:6380',
      expect.any(Object),
    );
  });

  it('configures lazyConnect=true to avoid connecting on construction', () => {
    createClient('redis://localhost:6379');
    const opts = (Redis as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(opts['lazyConnect']).toBe(true);
  });

  it('configures connectTimeout to fail fast (≤5000ms)', () => {
    createClient('redis://localhost:6379');
    const opts = (Redis as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(typeof opts['connectTimeout']).toBe('number');
    expect(opts['connectTimeout'] as number).toBeLessThanOrEqual(5000);
  });

  it('configures maxRetriesPerRequest=0 for health checks (fail fast, no retries)', () => {
    createClient('redis://localhost:6379');
    const opts = (Redis as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Record<string, unknown>;
    expect(opts['maxRetriesPerRequest']).toBe(0);
  });
});
