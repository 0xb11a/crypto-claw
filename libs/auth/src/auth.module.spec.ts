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

// ---------------------------------------------------------------------------
// Helper: extract the raw throttler option array from the DynamicModule
// returned by AppThrottlerModule.forRoot(). ThrottlerModule.forRoot() wraps
// the options in a DynamicModule that carries them as a provider. We access
// the innermost value by inspecting the providers array.
// ---------------------------------------------------------------------------
type ThrottlerOpt = {
  name: string;
  ttl: number;
  limit: number;
  skipIf?: (ctx: unknown) => boolean;
};

function makeCtx(role: string | undefined): unknown {
  return {
    switchToHttp: () => ({
      getRequest: () => ({ user: role !== undefined ? { role } : undefined }),
    }),
  };
}

function extractThrottlerOptions(mod: ReturnType<typeof AppThrottlerModule.forRoot>): ThrottlerOpt[] {
  // ThrottlerModule.forRoot() produces a DynamicModule whose providers
  // contain a value-provider holding the THROTTLER_OPTIONS token.
  // In @nestjs/throttler v5, providers[0] is typically the options provider.
  const providers = (mod as { providers?: { provide?: unknown; useValue?: unknown }[] }).providers ?? [];
  for (const p of providers) {
    if (Array.isArray(p.useValue)) {
      return p.useValue as ThrottlerOpt[];
    }
  }
  // Fall back: if the module returns the options at the top level (forRoot wraps forRootAsync).
  // Return an empty array so tests fail clearly rather than throw.
  return [];
}

describe('AppThrottlerModule.forRoot()', () => {
  it('returns a valid DynamicModule with throttler options', () => {
    const mod = AppThrottlerModule.forRoot();
    expect(mod).toBeTruthy();
    expect(typeof mod).toBe('object');
  });

  it('configures two named throttlers: agent (600/min) and dashboard (60/min)', () => {
    const mod = AppThrottlerModule.forRoot();
    const opts = extractThrottlerOptions(mod);
    expect(opts.length).toBeGreaterThanOrEqual(2);
    const agent = opts.find((o) => o.name === 'agent');
    const dashboard = opts.find((o) => o.name === 'dashboard');
    expect(agent).toBeDefined();
    expect(dashboard).toBeDefined();
    expect(agent!.limit).toBe(600);
    expect(dashboard!.limit).toBe(60);
    expect(agent!.ttl).toBe(60_000);
    expect(dashboard!.ttl).toBe(60_000);
  });

  describe('skipIf callbacks — SPEC §9.4 role isolation', () => {
    it('agent throttler: skipIf returns false (do throttle) when role=agent', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const agent = opts.find((o) => o.name === 'agent');
      expect(agent?.skipIf).toBeDefined();
      // role=agent → agent throttler should NOT skip (should apply) → skipIf returns false
      expect(agent!.skipIf!(makeCtx('agent'))).toBe(false);
    });

    it('agent throttler: skipIf returns true (do not throttle) when role=dashboard', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const agent = opts.find((o) => o.name === 'agent');
      expect(agent!.skipIf!(makeCtx('dashboard'))).toBe(true);
    });

    it('agent throttler: skipIf returns true when req.user is absent (unauthenticated)', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const agent = opts.find((o) => o.name === 'agent');
      expect(agent!.skipIf!(makeCtx(undefined))).toBe(true);
    });

    it('dashboard throttler: skipIf returns false (do throttle) when role=dashboard', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const dashboard = opts.find((o) => o.name === 'dashboard');
      expect(dashboard?.skipIf).toBeDefined();
      // role=dashboard → dashboard throttler should NOT skip → skipIf returns false
      expect(dashboard!.skipIf!(makeCtx('dashboard'))).toBe(false);
    });

    it('dashboard throttler: skipIf returns true (do not throttle) when role=agent', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const dashboard = opts.find((o) => o.name === 'dashboard');
      expect(dashboard!.skipIf!(makeCtx('agent'))).toBe(true);
    });

    it('dashboard throttler: skipIf returns true when req.user is absent (unauthenticated)', () => {
      const opts = extractThrottlerOptions(AppThrottlerModule.forRoot());
      const dashboard = opts.find((o) => o.name === 'dashboard');
      expect(dashboard!.skipIf!(makeCtx(undefined))).toBe(true);
    });
  });
});
