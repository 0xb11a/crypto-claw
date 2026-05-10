import { describe, it, expect } from 'vitest';
import { UnauthorizedException } from '@nestjs/common';
import { BearerAuthGuard } from './bearer-auth.guard.js';
import { IdentityRegistry } from './identity-registry.js';
import type { AppConfig } from '@cclaw/config';

const TEST_CONFIG = {
  RESEARCH_API_KEY: 'research-key-aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'sentinel-key-aaaaaaaaaaaaaaaa',
  EXECUTOR_API_KEY: 'executor-key-aaaaaaaaaaaaaaaa',
  OBSERVER_API_KEY: 'observer-key-aaaaaaaaaaaaaaaa',
  LOOP_API_KEY: 'loop-key-aaaaaaaaaaaaaaaaaaaaaaaa',
  WORKER_API_KEY: 'worker-key-aaaaaaaaaaaaaaaaaaaaaa',
  SCHEDULER_API_KEY: 'scheduler-key-aaaaaaaaaaaaaaaa',
  DASHBOARD_API_KEY: 'dashboard-key-aaaaaaaaaaaaaaa',
} as unknown as AppConfig;

function makeContext(authHeader?: string) {
  const req: Record<string, unknown> = {
    headers: authHeader ? { authorization: authHeader } : {},
    user: undefined,
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => () => undefined,
    getClass: () => class {},
  } as unknown as import('@nestjs/common').ExecutionContext;
}

describe('BearerAuthGuard', () => {
  const registry = new IdentityRegistry(TEST_CONFIG);
  const guard = new BearerAuthGuard(registry);

  it('sets req.user and returns true for a valid token', () => {
    const ctx = makeContext('Bearer research-key-aaaaaaaaaaaaaaaa'); // pre-commit-allow
    const result = guard.canActivate(ctx);
    expect(result).toBe(true);
    const req = ctx.switchToHttp().getRequest() as Record<string, unknown>;
    expect(req.user).toEqual({ identity: 'RESEARCH', role: 'agent' });
  });

  it('throws 401 when Authorization header is missing', () => {
    const ctx = makeContext();
    expect(() => guard.canActivate(ctx)).toThrowError(UnauthorizedException);
  });

  it('throws 401 for a malformed header (no Bearer prefix)', () => {
    const ctx = makeContext('research-key-aaaaaaaaaaaaaaaa');
    expect(() => guard.canActivate(ctx)).toThrowError(UnauthorizedException);
  });

  it('throws 401 for a Bearer header with no token', () => {
    const ctx = makeContext('Bearer ');
    // 'Bearer ' splits into ['Bearer', ''] — empty token should fail lookup
    expect(() => guard.canActivate(ctx)).toThrowError(UnauthorizedException);
  });

  it('throws 401 for an unknown token', () => {
    const ctx = makeContext('Bearer completely-unknown-token-xyz'); // pre-commit-allow
    expect(() => guard.canActivate(ctx)).toThrowError(UnauthorizedException);
  });

  it('is case-insensitive on the "Bearer" prefix', () => {
    const ctx = makeContext('bearer research-key-aaaaaaaaaaaaaaaa'); // pre-commit-allow
    expect(guard.canActivate(ctx)).toBe(true);
  });
});
