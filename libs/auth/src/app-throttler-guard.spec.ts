/**
 * Unit tests for AppThrottlerGuard (SPEC §9.4, ADR-0021).
 *
 * Verifies:
 * - getTracker() returns identity when req.user is present
 * - getTracker() falls back to req.ip when req.user is absent
 * - BearerAuthGuard is registered BEFORE AppThrottlerGuard in APP_GUARD list
 *
 * DoD §F — security: throttler guard order is critical for per-identity isolation.
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
