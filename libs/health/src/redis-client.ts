/**
 * redis-client.ts — Creates a transient ioredis client for health checks.
 *
 * BullMQ uses ioredis internally; this module uses the same client so the
 * health check is testing the same Redis endpoint that BullMQ uses.
 *
 * The client is created fresh per health check and closed immediately after.
 * This avoids holding a persistent connection in the health layer.
 */
import Redis from 'ioredis';

/**
 * Create a new ioredis client from a redis:// URL.
 *
 * @param redisUrl - Full Redis URL (e.g. redis://localhost:6379)
 * @returns Redis client instance (not yet connected).
 */
export function createClient(redisUrl: string): Redis {
  return new Redis(redisUrl, {
    // Fail fast on connection errors
    connectTimeout: 3000,
    maxRetriesPerRequest: 0,
    lazyConnect: true,
    enableOfflineQueue: false,
  });
}
