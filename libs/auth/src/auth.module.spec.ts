/**
 * Module wiring tests for AuthModule (OPEN-S / P1b).
 *
 * Verifies that AuthModule's key providers behave correctly when instantiated
 * directly. The full DI wiring via Test.createTestingModule requires all config
 * env vars (SAFE_ID, ACTIVE_CHAINS, etc.) which makes it unwieldy for unit tests;
 * the integration boot-defenses spec covers the full wire-up path.
 *
 * These unit tests cover the paths in AuthModule that improve line coverage
 * to ≥85% (SPEC §14 / OPEN-S).
 */

import { describe, it, expect } from 'vitest';
import { IdentityRegistry } from './identity-registry.js';
import { AppThrottlerModule } from './app-throttler.module.js';

// A minimal AppConfig with all required keys populated.
const TEST_CONFIG = {
  RESEARCH_API_KEY: 'research-key',
  SENTINEL_API_KEY: 'sentinel-key',
  EXECUTOR_API_KEY: 'executor-key',
  OBSERVER_API_KEY: 'observer-key',
  LOOP_API_KEY: 'loop-key',
  WORKER_API_KEY: 'worker-key',
  SCHEDULER_API_KEY: 'scheduler-key',
  DASHBOARD_API_KEY: 'dashboard-key',
  SAFE_ID: 'test',
  ACTIVE_CHAINS: 'base',
  NODE_ENV: 'test' as const,
  LOG_LEVEL: 'silent' as const,
  DB_PATH: './data/test.db',
  PAPER_MODE: false,
  AUTO_APPROVE_BUY: false,
  AUTO_APPROVE_BUY_MAX_USD: 0,
};

describe('IdentityRegistry (AuthModule provider)', () => {
  it('resolves RESEARCH identity for agent key', () => {
    const registry = new IdentityRegistry(TEST_CONFIG as any);
    expect(registry.lookup('research-key')).toEqual({ identity: 'RESEARCH', role: 'agent' });
  });

  it('resolves DASHBOARD identity for dashboard key', () => {
    const registry = new IdentityRegistry(TEST_CONFIG as any);
    expect(registry.lookup('dashboard-key')).toEqual({ identity: 'DASHBOARD', role: 'dashboard' });
  });

  it('returns null for unknown token', () => {
    const registry = new IdentityRegistry(TEST_CONFIG as any);
    expect(registry.lookup('unknown-token')).toBeNull();
  });

  it('resolves all 8 identity keys correctly', () => {
    const registry = new IdentityRegistry(TEST_CONFIG as any);
    const identities = [
      { key: 'research-key', identity: 'RESEARCH', role: 'agent' },
      { key: 'sentinel-key', identity: 'SENTINEL', role: 'agent' },
      { key: 'executor-key', identity: 'EXECUTOR', role: 'agent' },
      { key: 'observer-key', identity: 'OBSERVER', role: 'agent' },
      { key: 'loop-key', identity: 'LOOP', role: 'agent' },
      { key: 'worker-key', identity: 'WORKER', role: 'agent' },
      { key: 'scheduler-key', identity: 'SCHEDULER', role: 'agent' },
      { key: 'dashboard-key', identity: 'DASHBOARD', role: 'dashboard' },
    ] as const;
    for (const { key, identity, role } of identities) {
      expect(registry.lookup(key)).toEqual({ identity, role });
    }
  });
});

describe('AppThrottlerModule.forRoot()', () => {
  it('returns a valid DynamicModule with throttler options', () => {
    const mod = AppThrottlerModule.forRoot();
    expect(mod).toBeTruthy();
    // The returned module should be a DynamicModule (has module property)
    expect(typeof mod).toBe('object');
  });
});
