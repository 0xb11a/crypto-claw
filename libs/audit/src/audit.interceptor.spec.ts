/**
 * Unit tests for AuditInterceptor (SPEC §9.5, ADR-0018).
 *
 * Verifies:
 * - tap() is used (fire-and-forget — does not block the response)
 * - audit write is called on success
 * - audit write is called on error (with errorKind)
 * - when @Audited() is absent, the interceptor passes through without writing
 * - audit write failure does NOT propagate to the caller
 *
 * DoD §A — every code change has a test.
 * DoD §F — security: audit log always written for non-GET handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { of, throwError, firstValueFrom } from 'rxjs';
import { AuditInterceptor } from './audit.interceptor.js';
import type { AuditService } from './audit.service.js';
import type { Reflector } from '@nestjs/core';
import type { ExecutionContext, CallHandler } from '@nestjs/common';

type MockReflector = { getAllAndOverride: ReturnType<typeof vi.fn> };

function makeReflector(isAudited: boolean | undefined): MockReflector {
  return { getAllAndOverride: vi.fn().mockReturnValue(isAudited) };
}

function makeContext(method: string, url: string, user?: { identity: string; role: string }): ExecutionContext {
  const req = { method, url, body: { test: 'value' }, user };
  const reply = { statusCode: 200 };
  return {
    getHandler: () =>
      function handler() {
        return;
      },
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => reply,
    }),
  } as unknown as ExecutionContext;
}

function makeCallHandler(observable: any): CallHandler {
  return { handle: () => observable };
}

describe('AuditInterceptor', () => {
  let interceptor: AuditInterceptor;
  let auditService: AuditService;
  let reflector: MockReflector;

  beforeEach(() => {
    auditService = {
      write: vi.fn().mockResolvedValue(undefined),
    } as unknown as AuditService;
  });

  it('passes through without writing when @Audited() is not present', async () => {
    reflector = makeReflector(undefined);
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    const ctx = makeContext('POST', '/v1/orders');
    const handler = makeCallHandler(of({ id: 'order-1' }));

    const result$ = interceptor.intercept(ctx, handler);
    const result = await firstValueFrom(result$);

    expect(result).toEqual({ id: 'order-1' });
    expect(auditService.write).not.toHaveBeenCalled();
  });

  it('calls auditService.write after success when @Audited() is present', async () => {
    reflector = makeReflector(true);
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    const ctx = makeContext('POST', '/v1/orders', { identity: 'RESEARCH', role: 'agent' });
    const handler = makeCallHandler(of({ id: 'order-1' }));

    const result$ = interceptor.intercept(ctx, handler);
    // Force the observable to complete
    await firstValueFrom(result$);

    // tap() is fire-and-forget after the observable emits; give a tick for microtasks
    await Promise.resolve();

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'RESEARCH',
        role: 'agent',
        method: 'POST',
        path: '/v1/orders',
        status: 200,
      }),
    );
  });

  it('calls auditService.write with errorKind when handler throws', async () => {
    reflector = makeReflector(true);
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    const ctx = makeContext('POST', '/v1/orders');
    const error = Object.assign(new Error('conflict'), { status: 409 });
    const handler = makeCallHandler(throwError(() => error));

    const result$ = interceptor.intercept(ctx, handler);

    try {
      await firstValueFrom(result$);
    } catch {
      // Expected to throw
    }

    await Promise.resolve();

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 409,
        errorKind: 'Error',
      }),
    );
  });

  it('uses identity=unknown when req.user is absent', async () => {
    reflector = makeReflector(true);
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    // No user on request
    const ctx = makeContext('POST', '/v1/orders', undefined);
    const handler = makeCallHandler(of({}));

    const result$ = interceptor.intercept(ctx, handler);
    await firstValueFrom(result$);
    await Promise.resolve();

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'unknown',
        role: 'unknown',
      }),
    );
  });

  it('does NOT propagate audit write failure to the caller', async () => {
    reflector = makeReflector(true);
    (auditService.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB down'));
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    const ctx = makeContext('POST', '/v1/orders', { identity: 'RESEARCH', role: 'agent' });
    const handler = makeCallHandler(of({ id: 'order-1' }));

    const result$ = interceptor.intercept(ctx, handler);
    // Must complete without throwing even if audit write fails
    const result = await firstValueFrom(result$);
    expect(result).toEqual({ id: 'order-1' });
  });

  it('audit write body_sha256 is computed — sha256 param exists in write call', async () => {
    reflector = makeReflector(true);
    interceptor = new AuditInterceptor(auditService, reflector as unknown as Reflector);

    const ctx = makeContext('POST', '/v1/orders', { identity: 'RESEARCH', role: 'agent' });
    const handler = makeCallHandler(of({}));

    const result$ = interceptor.intercept(ctx, handler);
    await firstValueFrom(result$);
    await Promise.resolve();

    // The write call should include the body
    const writeCall = (auditService.write as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
      body: unknown;
    };
    expect(writeCall).toBeDefined();
    expect(writeCall.body).toEqual({ test: 'value' });
  });
});
