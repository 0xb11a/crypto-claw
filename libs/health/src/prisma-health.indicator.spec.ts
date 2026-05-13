/**
 * Unit tests for prisma-health.indicator.ts
 *
 * SPEC §11 — /readyz checks Prisma connectivity.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckError } from '@nestjs/terminus';
import { PrismaHealthIndicator } from './prisma-health.indicator.js';

afterEach(() => {
  vi.clearAllMocks();
});

function makePrismaService(queryResult: 'ok' | Error) {
  return {
    $queryRaw: vi.fn().mockImplementation(() => {
      if (queryResult instanceof Error) return Promise.reject(queryResult);
      return Promise.resolve([{ '1': 1 }]);
    }),
  };
}

describe('PrismaHealthIndicator.isHealthy()', () => {
  it('returns up when Prisma query succeeds', async () => {
    const prisma = makePrismaService('ok');
    const indicator = new PrismaHealthIndicator(prisma as never);
    const result = await indicator.isHealthy('prisma');
    expect(result['prisma'].status).toBe('up');
  });

  it('throws HealthCheckError when Prisma query fails', async () => {
    const prisma = makePrismaService(new Error('SQLITE_CANTOPEN'));
    const indicator = new PrismaHealthIndicator(prisma as never);
    await expect(indicator.isHealthy('prisma')).rejects.toThrow(HealthCheckError);
  });

  it('includes error detail in HealthCheckError when query fails', async () => {
    const prisma = makePrismaService(new Error('SQLITE_CANTOPEN'));
    const indicator = new PrismaHealthIndicator(prisma as never);
    try {
      await indicator.isHealthy('prisma');
      expect.fail('Expected HealthCheckError');
    } catch (err) {
      expect(err).toBeInstanceOf(HealthCheckError);
      expect((err as HealthCheckError).message).toContain('Prisma health check failed');
    }
  });
});
