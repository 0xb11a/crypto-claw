/**
 * Unit tests for AppThrottlerGuard (SPEC §9.4, ADR-0021).
 *
 * Verifies:
 * - getTracker() returns identity when req.user is present
 * - getTracker() falls back to req.ip when req.user is absent
 * - BearerAuthGuard is registered BEFORE AppThrottlerGuard in APP_GUARD list
 *
 * DoD §F — security: throttler guard order is critical for per-identity isolation.
 *
 * BLOCKER tests (labeled [OPEN-1] and [OPEN-2]) added by tester to document
 * spec violations discovered in P1b review. These tests FAIL on the current
 * implementation and must pass before merge.
 */

import { describe, it, expect, vi } from 'vitest';
import { AppThrottlerGuard } from './app-throttler-guard.js';

// ---------------------------------------------------------------------------
// Guard order test — reads the app.module.ts to assert BearerAuthGuard
// comes before AppThrottlerGuard in the APP_GUARD provider list.
// ---------------------------------------------------------------------------
describe('AppThrottlerGuard — guard order invariant', () => {
  it('AuthModule import appears before AppThrottlerGuard APP_GUARD provider in app.module.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const appModulePath = resolve(__dirname, '../../../apps/api/src/app.module.ts');
    const content = readFileSync(appModulePath, 'utf8');

    // AuthModule is imported at the top (it contains BearerAuthGuard as APP_GUARD)
    const authModuleImportIdx = content.indexOf('AuthModule,');
    // AppThrottlerGuard is registered as APP_GUARD in the providers array
    const throttlerProviderIdx = content.indexOf('useClass: AppThrottlerGuard');

    // AuthModule import must precede the AppThrottlerGuard provider registration
    expect(authModuleImportIdx).toBeGreaterThan(-1);
    expect(throttlerProviderIdx).toBeGreaterThan(-1);
    expect(authModuleImportIdx).toBeLessThan(throttlerProviderIdx);
  });
});

// ---------------------------------------------------------------------------
// getTracker() unit tests
// ---------------------------------------------------------------------------

describe('AppThrottlerGuard.getTracker()', () => {
  it('returns identity when req.user is present', async () => {
    const guard = Object.create(AppThrottlerGuard.prototype) as typeof AppThrottlerGuard.prototype;
    const getTracker = (guard as unknown as { getTracker: (req: unknown) => Promise<string> }).getTracker.bind(guard);

    const result = await getTracker({ user: { identity: 'RESEARCH', role: 'agent' }, ip: '127.0.0.1' });
    expect(result).toBe('RESEARCH');
  });

  it('falls back to ip when req.user is undefined', async () => {
    const guard = Object.create(AppThrottlerGuard.prototype) as typeof AppThrottlerGuard.prototype;
    const getTracker = (guard as unknown as { getTracker: (req: unknown) => Promise<string> }).getTracker.bind(guard);

    const result = await getTracker({ ip: '192.168.1.1' });
    expect(result).toBe('192.168.1.1');
  });

  it('falls back to "unknown" when both user and ip are absent', async () => {
    const guard = Object.create(AppThrottlerGuard.prototype) as typeof AppThrottlerGuard.prototype;
    const getTracker = (guard as unknown as { getTracker: (req: unknown) => Promise<string> }).getTracker.bind(guard);

    const result = await getTracker({});
    expect(result).toBe('unknown');
  });
});

// ---------------------------------------------------------------------------
// [OPEN-1] BLOCKER: named throttler role-isolation violation (SPEC §9.4)
// ---------------------------------------------------------------------------
// In @nestjs/throttler v5, canActivate() iterates ALL named throttlers.
// With no skipIf per throttler, both the "agent" (600/min) AND "dashboard"
// (60/min) throttlers apply to every request, regardless of user role.
// An agent identity is therefore limited to 60/min (the dashboard throttler
// limit), not 600/min as SPEC §9.4 requires.
//
// Empirically verified: hit 61 successive /v1/receipts requests with an agent
// token → 429 on request 61. x-ratelimit-limit-dashboard: 60 header confirms
// the dashboard throttler fires.
//
// Required fix: add skipIf callbacks to the named throttler configs, e.g.:
//   { name: 'agent', limit: 600, ttl: 60000,
//     skipIf: (ctx) => ctx.switchToHttp().getRequest()?.user?.role !== 'agent' }
//   { name: 'dashboard', limit: 60, ttl: 60000,
//     skipIf: (ctx) => ctx.switchToHttp().getRequest()?.user?.role !== 'dashboard' }
//
// [OPEN-1] This test FAILS today. Remove this comment when the fix lands.
describe('AppThrottlerGuard — SPEC §9.4 per-role throttler selection [OPEN-1 BLOCKER]', () => {
  it('[OPEN-1] AppThrottlerModule must configure each named throttler with a role-selecting skipIf', async () => {
    // Read the throttler module source and verify each named throttler has
    // a skipIf property. Without skipIf, both throttlers apply to all requests
    // and agents are silently limited to the dashboard quota (60/min).
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, 'app-throttler.module.ts'), 'utf8');

    // Each named throttler must have a skipIf callback for role isolation
    // (or equivalent: the guard must select throttlers based on req.user.role).
    //
    // Current state: no skipIf in the source → this assertion FAILS.
    expect(src).toMatch(/skipIf/);
  });

  it('[OPEN-1] @SkipThrottle() on HealthController must target named throttlers, not "default"', async () => {
    // @SkipThrottle() in @nestjs/throttler v5 defaults to { default: true }.
    // Since no throttler is named "default", the skip is a no-op for "agent"/"dashboard".
    // healthz/readyz are therefore NOT throttle-exempt despite @SkipThrottle().
    //
    // Empirically verified: GET /healthz returns x-ratelimit-limit-agent and
    // x-ratelimit-limit-dashboard headers and decrements both buckets.
    //
    // Fix: @SkipThrottle({ agent: true, dashboard: true }) in HealthController.
    //
    // This test reads the HealthController source to assert the named skip form.
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const src = readFileSync(resolve(__dirname, '../../../libs/health/src/health.controller.ts'), 'utf8');

    // Current state: @SkipThrottle() with no args → this assertion FAILS.
    expect(src).toMatch(/@SkipThrottle\(\{/);
  });
});

// ---------------------------------------------------------------------------
// [OPEN-2] BLOCKER: new modules missing from vitest.workspace.ts
// ---------------------------------------------------------------------------
// libs/modules/receipts, alerts, and heartbeat are not registered in
// vitest.workspace.ts. pnpm test:unit does not run their specs. The CI
// coverage gate does not track them. 73 tests (22 receipts + 25 alerts +
// 26 heartbeat) are unreachable from the standard CI run.
//
// Fix: add three entries to vitest.workspace.ts:
//   'libs/modules/receipts/vitest.config.ts',
//   'libs/modules/alerts/vitest.config.ts',
//   'libs/modules/heartbeat/vitest.config.ts',
//
// [OPEN-2] This test FAILS today. Remove this comment when the fix lands.
describe('vitest.workspace.ts registration — [OPEN-2 BLOCKER]', () => {
  it('[OPEN-2] libs/modules/receipts, alerts, heartbeat must be registered in vitest.workspace.ts', async () => {
    const { readFileSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const workspace = readFileSync(resolve(__dirname, '../../../vitest.workspace.ts'), 'utf8');

    // All three new P1b modules must be present
    expect(workspace).toContain('libs/modules/receipts/vitest.config.ts');
    expect(workspace).toContain('libs/modules/alerts/vitest.config.ts');
    expect(workspace).toContain('libs/modules/heartbeat/vitest.config.ts');
  });
});

// ---------------------------------------------------------------------------
// throwThrottlingException() — throws and logs structured context
// ---------------------------------------------------------------------------

describe('AppThrottlerGuard.throwThrottlingException()', () => {
  it('throws ThrottlerException', async () => {
    const { ThrottlerException } = await import('@nestjs/throttler');

    const guard = Object.create(AppThrottlerGuard.prototype) as typeof AppThrottlerGuard.prototype;
    (guard as unknown as { logger: unknown }).logger = { warn: vi.fn() };

    const context = {
      switchToHttp: () => ({
        getRequest: () => ({ user: { identity: 'RESEARCH', role: 'agent' }, ip: '127.0.0.1', url: '/v1/orders' }),
      }),
    };

    type ThrowFn = (ctx: unknown, detail: unknown) => Promise<void>;
    await expect(
      (guard as unknown as { throwThrottlingException: ThrowFn }).throwThrottlingException(context, {}),
    ).rejects.toThrow(ThrottlerException);
  });
});
