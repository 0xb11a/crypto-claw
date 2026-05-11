/**
 * executor-health.indicator.ts — Terminus health indicator for executor binary presence.
 *
 * Checks that the executor binary exists at the configured path.
 * If the binary is missing, the worker cannot execute orders and readiness fails.
 *
 * SPEC §11 — /readyz checks executor binary present.
 * @see DoD §E — health check updated because executor binary affects readiness.
 */
import { Injectable } from '@nestjs/common';
import { HealthIndicator, HealthIndicatorResult, HealthCheckError } from '@nestjs/terminus';
import { existsSync } from 'node:fs';
import { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@cclaw/config';
import { getExecutorPath } from '@cclaw/execution';

/**
 * Health indicator that checks the executor binary exists.
 *
 * Uses existsSync (synchronous, cheap). A missing binary is a deploy error.
 */
@Injectable()
export class ExecutorHealthIndicator extends HealthIndicator {
  constructor(private readonly configService: ConfigService) {
    super();
  }

  /**
   * Check executor binary exists.
   *
   * @param key - The key for this indicator in the health check response.
   * @returns HealthIndicatorResult — { [key]: { status: 'up' | 'down', path } }
   * @throws HealthCheckError if binary is missing.
   */
  isHealthy(key: string): HealthIndicatorResult {
    const cfg = this.configService.get<AppConfig>('') as AppConfig;
    const executorPath = getExecutorPath({ EXECUTOR_BIN_PATH: cfg.EXECUTOR_BIN_PATH });
    const exists = existsSync(executorPath);

    if (!exists) {
      throw new HealthCheckError(
        `Executor binary not found at ${executorPath}`,
        this.getStatus(key, false, { path: executorPath }),
      );
    }

    return this.getStatus(key, true, { path: executorPath });
  }
}
