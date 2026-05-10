import { describe, it, expect } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RolesGuard } from './roles.guard.js';
import { ROLES_KEY } from './roles.decorator.js';

function makeContext(userRole: string | undefined, handlerRoles: string[] | undefined) {
  const req = { user: userRole ? { identity: 'RESEARCH', role: userRole } : undefined };
  const handler = () => undefined;
  const klass = class {};

  // Mock Reflector
  const reflector = {
    getAllAndOverride: (key: string) => {
      if (key === ROLES_KEY) return handlerRoles;
      return undefined;
    },
  } as unknown as Reflector;

  const ctx = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => klass,
  } as unknown as import('@nestjs/common').ExecutionContext;

  return { ctx, reflector };
}

describe('RolesGuard', () => {
  it('allows access when role matches', () => {
    const { ctx, reflector } = makeContext('agent', ['agent']);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('allows access for dashboard when dashboard role is listed', () => {
    const { ctx, reflector } = makeContext('dashboard', ['agent', 'dashboard']);
    const guard = new RolesGuard(reflector);
    expect(guard.canActivate(ctx)).toBe(true);
  });

  it('throws 403 when role does not match', () => {
    const { ctx, reflector } = makeContext('dashboard', ['agent']);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrowError(ForbiddenException);
  });

  it('throws 403 when @Roles decorator is missing (default-deny)', () => {
    const { ctx, reflector } = makeContext('agent', undefined);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrowError(ForbiddenException);
  });

  it('throws 403 when @Roles is empty array (default-deny)', () => {
    const { ctx, reflector } = makeContext('agent', []);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrowError(ForbiddenException);
  });

  it('throws 403 when user is undefined (BearerAuthGuard did not run)', () => {
    const { ctx, reflector } = makeContext(undefined, ['agent']);
    const guard = new RolesGuard(reflector);
    expect(() => guard.canActivate(ctx)).toThrowError(ForbiddenException);
  });
});
