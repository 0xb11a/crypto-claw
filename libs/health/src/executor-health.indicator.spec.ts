/**
 * Unit tests for executor-health.indicator.ts
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { HealthCheckError } from '@nestjs/terminus';
import { ExecutorHealthIndicator } from './executor-health.indicator.js';

// Mock existsSync to control whether the binary "exists"
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
}));

// Mock getExecutorPath to return a deterministic path
vi.mock('@cclaw/execution', () => ({
  getExecutorPath: vi.fn(() => '/fake/apps/executor/dist/main.js'),
}));

import { existsSync } from 'node:fs';

function makeConfigService(overrides: Record<string, unknown> = {}) {
  return {
    get: vi.fn(() => ({ EXECUTOR_BIN_PATH: undefined, ...overrides })),
  };
}

describe('ExecutorHealthIndicator.isHealthy()', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('returns up when binary exists', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const indicator = new ExecutorHealthIndicator(makeConfigService() as never);
    const result = indicator.isHealthy('executor');
    expect(result['executor'].status).toBe('up');
  });

  it('throws HealthCheckError when binary is missing', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const indicator = new ExecutorHealthIndicator(makeConfigService() as never);
    expect(() => indicator.isHealthy('executor')).toThrow(HealthCheckError);
  });

  it('includes path in result when binary exists', () => {
    (existsSync as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const indicator = new ExecutorHealthIndicator(makeConfigService() as never);
    const result = indicator.isHealthy('executor');
    expect(result['executor'].path).toBe('/fake/apps/executor/dist/main.js');
  });
});
