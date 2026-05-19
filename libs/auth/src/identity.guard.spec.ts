/**
 * Unit tests for IdentityGuard (P7 — shadow/enforce mode).
 *
 * DoD §A — every code change has a test.
 * DoD §F — security changes: IdentityGuard is the per-identity authz enforcement.
 *
 * Test matrix:
 *   shadow mode × { wildcard, match, mismatch, missing-decorator, missing-user }
 *   enforce mode × { wildcard, match, mismatch, missing-decorator, missing-user }
 *   rate-limit invariant (shadow mode, blocked route hit N×)
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { IdentityGuard } from './identity.guard.js';
import { IdentityForbiddenException } from './identity-forbidden.exception.js';
import { IDENTITIES_KEY } from './identities.decorator.js';
import type { IdentitySpec } from './identities.decorator.js';
import type { IdentityName, RoleName } from './identity-registry.js';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/** Build a minimal ExecutionContext fake. */
function makeContext(opts: {
  identities?: IdentitySpec[] | null;
  identity?: IdentityName;
  role?: RoleName;
  method?: string;
  url?: string;
  // any is appropriate here — the ExecutionContext shape is only used in tests
}): any {
  const { identities, identity, role, method = 'GET', url = '/test' } = opts;

  const handler = function testHandler() {
    return;
  };

  if (identities !== undefined && identities !== null) {
    Reflect.defineMetadata(IDENTITIES_KEY, identities, handler);
  }

  const req = {
    method,
    url,
    routeOptions: { url },
    ...(identity !== undefined ? { user: { identity, role: role ?? 'agent' } } : {}),
  };

  return {
    getHandler: () => handler,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
    }),
  };
}

/**
 * Build an IdentityGuard with a controlled shadowMode.
 *
 * Env-mutation safety: this helper temporarily writes to `process.env['AUTHZ_SHADOW_MODE']`
 * and restores the original value before returning. This is safe across spec files
 * because vitest workers are process-isolated by default (each spec file runs in its
 * own worker). If a future maintainer adds `--no-isolate` to the vitest config, this
 * helper must be refactored to use `beforeEach`/`afterEach` env-restore wrappers
 * (e.g. via `vi.stubEnv`) to avoid cross-test contamination.
 */
function makeGuard(shadowMode: boolean): IdentityGuard {
  // Override process.env before construction
  const originalEnv = process.env['AUTHZ_SHADOW_MODE'];
  process.env['AUTHZ_SHADOW_MODE'] = shadowMode ? '1' : '0';

  const reflector = {
    getAllAndOverride: (key: string, targets: object[]): IdentitySpec[] | undefined => {
      for (const t of targets) {
        const val = Reflect.getMetadata(key, t);
        if (val !== undefined) return val as IdentitySpec[];
      }
      return undefined;
    },
  };

  const guard = new IdentityGuard(reflector as unknown as import('@nestjs/core').Reflector);

  // Restore env
  if (originalEnv === undefined) {
    delete process.env['AUTHZ_SHADOW_MODE'];
  } else {
    process.env['AUTHZ_SHADOW_MODE'] = originalEnv;
  }

  return guard;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdentityGuard — shadow mode (AUTHZ_SHADOW_MODE=1)', () => {
  let stderrSpy: any;
  let shadowGuard: IdentityGuard;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    shadowGuard = makeGuard(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('isShadowMode returns true when AUTHZ_SHADOW_MODE=1', () => {
    expect(shadowGuard.isShadowMode).toBe(true);
  });

  it('passes when @Identities("*") wildcard is set (any identity)', () => {
    const ctx = makeContext({ identities: ['*'], identity: 'RESEARCH' });
    expect(shadowGuard.canActivate(ctx)).toBe(true);
    // No log expected for wildcard
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('passes when identity matches explicit allowlist', () => {
    const ctx = makeContext({ identities: ['RESEARCH', 'SENTINEL'], identity: 'RESEARCH' });
    expect(shadowGuard.canActivate(ctx)).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('passes but logs identity_blocked_shadow when identity not in allowlist', () => {
    const ctx = makeContext({ identities: ['EXECUTOR'], identity: 'RESEARCH' });
    const result = shadowGuard.canActivate(ctx);
    expect(result).toBe(true); // shadow: pass
    expect(stderrSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(stderrSpy.mock.calls[0]![0]! as string) as Record<string, unknown>;
    expect(logged.event).toBe('identity_blocked_shadow');
    expect(logged.identity).toBe('RESEARCH');
    expect(logged.shadowMode).toBe(true);
  });

  it('passes but logs identity_decorator_missing when @Identities is absent', () => {
    const ctx = makeContext({ identities: null, identity: 'RESEARCH' }); // no decorator
    // Remove the metadata to simulate missing decorator
    const handler = ctx.getHandler() as object;
    Reflect.deleteMetadata(IDENTITIES_KEY, handler);

    const result = shadowGuard.canActivate(ctx);
    expect(result).toBe(true); // shadow: pass
    expect(stderrSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(stderrSpy.mock.calls[0]![0]! as string) as Record<string, unknown>;
    expect(logged.event).toBe('identity_decorator_missing');
  });

  it('passes when req.user is missing (no authenticated user)', () => {
    // BearerAuthGuard should catch this; guard defensively passes in shadow mode
    const ctx = makeContext({ identities: ['EXECUTOR'] }); // no identity
    expect(shadowGuard.canActivate(ctx)).toBe(true);
  });

  it('passes with DASHBOARD wildcard identity on GET route', () => {
    const ctx = makeContext({ identities: ['*'], identity: 'DASHBOARD', role: 'dashboard' });
    expect(shadowGuard.canActivate(ctx)).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('passes LOOP identity on wildcard route', () => {
    const ctx = makeContext({ identities: ['*'], identity: 'LOOP' });
    expect(shadowGuard.canActivate(ctx)).toBe(true);
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it('WORKER identity on non-empty allowlist logs shadow block', () => {
    const ctx = makeContext({ identities: ['EXECUTOR', 'LOOP'], identity: 'WORKER' });
    const result = shadowGuard.canActivate(ctx);
    expect(result).toBe(true); // shadow: pass
    expect(stderrSpy).toHaveBeenCalledOnce();
    const logged = JSON.parse(stderrSpy.mock.calls[0]![0]! as string) as Record<string, unknown>;
    expect(logged.identity).toBe('WORKER');
    expect(logged.event).toBe('identity_blocked_shadow');
  });

  it('SCHEDULER identity on non-empty allowlist logs shadow block', () => {
    const ctx = makeContext({ identities: ['RESEARCH'], identity: 'SCHEDULER' });
    const result = shadowGuard.canActivate(ctx);
    expect(result).toBe(true); // shadow: pass
    const logged = JSON.parse(stderrSpy.mock.calls[0]![0]! as string) as Record<string, unknown>;
    expect(logged.identity).toBe('SCHEDULER');
  });
});

describe('IdentityGuard — shadow mode rate-limit', () => {
  let stderrSpy: any;
  let shadowGuard: IdentityGuard;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    shadowGuard = makeGuard(true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('emits exactly one log line per minute for repeated blocked requests from the same (identity, path)', () => {
    const ctx = makeContext({ identities: ['EXECUTOR'], identity: 'RESEARCH', method: 'POST', url: '/v1/orders' });

    // Hit the route 5 times in quick succession
    for (let i = 0; i < 5; i++) {
      shadowGuard.canActivate(ctx);
    }

    // Expect exactly 1 stderr.write call (rate-limited)
    expect(stderrSpy).toHaveBeenCalledOnce();
  });

  it('emits separate log lines for different (identity, path) combinations', () => {
    const ctx1 = makeContext({ identities: ['EXECUTOR'], identity: 'RESEARCH', url: '/v1/orders' });
    const ctx2 = makeContext({ identities: ['EXECUTOR'], identity: 'SENTINEL', url: '/v1/orders' });

    shadowGuard.canActivate(ctx1);
    shadowGuard.canActivate(ctx2);

    // Both have distinct keys → 2 log lines
    expect(stderrSpy).toHaveBeenCalledTimes(2);
  });
});

describe('IdentityGuard — enforce mode (AUTHZ_SHADOW_MODE=0)', () => {
  let stderrSpy: any;
  let enforceGuard: IdentityGuard;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    enforceGuard = makeGuard(false);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
  });

  it('isShadowMode returns false when AUTHZ_SHADOW_MODE=0', () => {
    expect(enforceGuard.isShadowMode).toBe(false);
  });

  it('passes when @Identities("*") wildcard is set', () => {
    const ctx = makeContext({ identities: ['*'], identity: 'RESEARCH' });
    expect(enforceGuard.canActivate(ctx)).toBe(true);
  });

  it('passes when identity matches explicit allowlist', () => {
    const ctx = makeContext({ identities: ['EXECUTOR', 'LOOP'], identity: 'EXECUTOR' });
    expect(enforceGuard.canActivate(ctx)).toBe(true);
  });

  it('throws IdentityForbiddenException (a ForbiddenException subclass) when identity not in allowlist', () => {
    const ctx = makeContext({ identities: ['EXECUTOR'], identity: 'RESEARCH' });
    // IdentityForbiddenException extends ForbiddenException — both assertions must pass
    expect(() => enforceGuard.canActivate(ctx)).toThrow(ForbiddenException);
    expect(() => enforceGuard.canActivate(ctx)).toThrow(IdentityForbiddenException);
  });

  it('thrown exception message contains the identity name', () => {
    const ctx = makeContext({ identities: ['EXECUTOR'], identity: 'SENTINEL' });
    let thrown: IdentityForbiddenException | undefined;
    try {
      enforceGuard.canActivate(ctx);
    } catch (err) {
      thrown = err as IdentityForbiddenException;
    }
    expect(thrown).toBeInstanceOf(IdentityForbiddenException);
    expect(thrown).toBeInstanceOf(ForbiddenException); // subclass check
    expect(thrown?.message).toContain('SENTINEL');
  });

  it('throws IdentityForbiddenException when @Identities is absent', () => {
    const ctx = makeContext({ identities: null, identity: 'RESEARCH' });
    const handler = ctx.getHandler() as object;
    Reflect.deleteMetadata(IDENTITIES_KEY, handler);
    expect(() => enforceGuard.canActivate(ctx)).toThrow(IdentityForbiddenException);
  });

  it('throws IdentityForbiddenException when req.user is missing', () => {
    const ctx = makeContext({ identities: ['EXECUTOR'] }); // no user
    expect(() => enforceGuard.canActivate(ctx)).toThrow(IdentityForbiddenException);
  });

  it('WORKER identity throws IdentityForbiddenException on any non-wildcard route', () => {
    const ctx = makeContext({ identities: ['RESEARCH', 'SENTINEL'], identity: 'WORKER' });
    expect(() => enforceGuard.canActivate(ctx)).toThrow(IdentityForbiddenException);
  });

  it('SCHEDULER identity throws IdentityForbiddenException on any non-wildcard route', () => {
    const ctx = makeContext({ identities: ['RESEARCH'], identity: 'SCHEDULER' });
    expect(() => enforceGuard.canActivate(ctx)).toThrow(IdentityForbiddenException);
  });
});
