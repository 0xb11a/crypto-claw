/**
 * Unit tests for health.controller.ts
 *
 * Tests the HealthController endpoints in isolation, with all dependencies mocked.
 *
 * SPEC §11 — /healthz + /readyz endpoints.
 * DoD §A — every code change has a test.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckError } from '@nestjs/terminus';
import { HealthController } from './health.controller.js';

afterEach(() => {
  vi.clearAllMocks();
});

function makeHealthCheckService(outcome: 'healthy' | 'unhealthy' = 'healthy') {
  return {
    check: vi.fn().mockImplementation(async (checks: Array<() => Promise<unknown> | unknown>) => {
      if (outcome === 'unhealthy') {
        throw new HealthCheckError('some check failed', { status: 'error' });
      }
      const results: Record<string, unknown> = {};
      for (const check of checks) {
        const result = await check();
        if (result && typeof result === 'object') {
          Object.assign(results, result as Record<string, unknown>);
        }
      }
      return { status: 'ok', details: results };
    }),
  };
}

function makePrismaIndicator(healthy = true) {
  return {
    isHealthy: vi.fn().mockImplementation((key: string) => {
      if (!healthy) throw new HealthCheckError('Prisma down', { [key]: { status: 'down' } });
      return Promise.resolve({ [key]: { status: 'up' } });
    }),
  };
}

function makeRedisIndicator(healthy = true) {
  return {
    isHealthy: vi.fn().mockImplementation((key: string) => {
      if (!healthy) throw new HealthCheckError('Redis down', { [key]: { status: 'down' } });
      return Promise.resolve({ [key]: { status: 'up' } });
    }),
  };
}

function makeExecutorIndicator(healthy = true) {
  return {
    isHealthy: vi.fn().mockImplementation((key: string) => {
      if (!healthy) throw new HealthCheckError('Executor missing', { [key]: { status: 'down' } });
      return { [key]: { status: 'up', path: '/fake/executor' } };
    }),
  };
}

describe('HealthController', () => {
  describe('liveness()', () => {
    it('returns { status: "ok" }', () => {
      const ctrl = new HealthController(
        makeHealthCheckService() as never,
        makePrismaIndicator() as never,
        makeRedisIndicator() as never,
        makeExecutorIndicator() as never,
      );
      const result = ctrl.liveness();
      expect(result).toEqual({ status: 'ok' });
    });

    it('never throws (liveness is unconditional)', () => {
      // Even if all health indicators are broken, liveness must return 200
      const ctrl = new HealthController(
        makeHealthCheckService() as never,
        makePrismaIndicator(false) as never,
        makeRedisIndicator(false) as never,
        makeExecutorIndicator(false) as never,
      );
      expect(() => ctrl.liveness()).not.toThrow();
    });
  });

  describe('readiness()', () => {
    it('calls health.check() with three indicators', async () => {
      const healthCheckSvc = makeHealthCheckService();
      const ctrl = new HealthController(
        healthCheckSvc as never,
        makePrismaIndicator() as never,
        makeRedisIndicator() as never,
        makeExecutorIndicator() as never,
      );
      await ctrl.readiness();
      expect(healthCheckSvc.check).toHaveBeenCalledOnce();
      const checkArgs = (healthCheckSvc.check as ReturnType<typeof vi.fn>).mock.calls[0][0] as unknown[];
      // Should have 3 check functions: prisma, redis, executor
      expect(checkArgs).toHaveLength(3);
    });

    it('delegates to HealthCheckService and returns its result', async () => {
      const healthCheckSvc = makeHealthCheckService('healthy');
      const ctrl = new HealthController(
        healthCheckSvc as never,
        makePrismaIndicator() as never,
        makeRedisIndicator() as never,
        makeExecutorIndicator() as never,
      );
      const result = await ctrl.readiness();
      expect(result).toBeDefined();
      expect((result as { status: string }).status).toBe('ok');
    });

    it('re-throws HealthCheckError from HealthCheckService (503 path)', async () => {
      const healthCheckSvc = makeHealthCheckService('unhealthy');
      const ctrl = new HealthController(
        healthCheckSvc as never,
        makePrismaIndicator() as never,
        makeRedisIndicator() as never,
        makeExecutorIndicator() as never,
      );
      await expect(ctrl.readiness()).rejects.toThrow(HealthCheckError);
    });

    it('calls prismaIndicator.isHealthy with key "prisma"', async () => {
      const prismaIndicator = makePrismaIndicator();
      const ctrl = new HealthController(
        makeHealthCheckService() as never,
        prismaIndicator as never,
        makeRedisIndicator() as never,
        makeExecutorIndicator() as never,
      );
      await ctrl.readiness();
      expect(prismaIndicator.isHealthy).toHaveBeenCalledWith('prisma');
    });

    it('calls redisIndicator.isHealthy with key "redis"', async () => {
      const redisIndicator = makeRedisIndicator();
      const ctrl = new HealthController(
        makeHealthCheckService() as never,
        makePrismaIndicator() as never,
        redisIndicator as never,
        makeExecutorIndicator() as never,
      );
      await ctrl.readiness();
      expect(redisIndicator.isHealthy).toHaveBeenCalledWith('redis');
    });

    it('calls executorIndicator.isHealthy with key "executor"', async () => {
      const executorIndicator = makeExecutorIndicator();
      const ctrl = new HealthController(
        makeHealthCheckService() as never,
        makePrismaIndicator() as never,
        makeRedisIndicator() as never,
        executorIndicator as never,
      );
      await ctrl.readiness();
      expect(executorIndicator.isHealthy).toHaveBeenCalledWith('executor');
    });
  });
});
