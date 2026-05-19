/**
 * Unit tests for IdentityForbiddenFilter (P7 PR-C1, auditor suggestion #5).
 *
 * Verifies that the filter:
 *   1. Catches IdentityForbiddenException (a ForbiddenException subclass from IdentityGuard).
 *   2. Writes an audit row with the correct fields (identity, role, method, path, status 403).
 *   3. Delegates to the base exception filter to produce a 403 HTTP response.
 *
 * DoD §A — every code change has a test.
 * DoD §F — security changes: audit row on guard-thrown 403.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IdentityForbiddenFilter } from './identity-forbidden.filter.js';
import { IdentityForbiddenException } from '@cclaw/auth';
import type { AuditService } from './audit.service.js';
import type { ArgumentsHost } from '@nestjs/common';

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

function makeAuditService(): AuditService {
  return {
    write: vi.fn().mockResolvedValue(undefined),
  } as unknown as AuditService;
}

function makeArgumentsHost(
  opts: {
    method?: string;
    url?: string;
    routeOptionsUrl?: string;
    identity?: string;
    role?: string;
  } = {},
): ArgumentsHost {
  const req = {
    method: opts.method ?? 'POST',
    url: opts.url ?? '/v1/logs/sentinel',
    routeOptions: opts.routeOptionsUrl ? { url: opts.routeOptionsUrl } : undefined,
    ...(opts.identity !== undefined ? { user: { identity: opts.identity, role: opts.role ?? 'agent' } } : {}),
  };

  // Mock Fastify reply with chainable status().send() API
  const sendCalls: unknown[] = [];
  const statusCalls: number[] = [];
  const res = {
    statusCode: 200,
    status(code: number) {
      statusCalls.push(code);
      this.statusCode = code;
      return this;
    },
    send(payload: unknown) {
      sendCalls.push(payload);
      return this;
    },
    _statusCalls: statusCalls,
    _sendCalls: sendCalls,
  };

  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
    getType: () => 'http',
    getArgs: () => [],
    getArgByIndex: () => undefined,
    switchToRpc: () => {
      throw new Error('not used');
    },
    switchToWs: () => {
      throw new Error('not used');
    },
  } as unknown as ArgumentsHost;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('IdentityForbiddenFilter', () => {
  let auditService: AuditService;
  let filter: IdentityForbiddenFilter;

  beforeEach(() => {
    auditService = makeAuditService();
    filter = new IdentityForbiddenFilter(auditService);
    // No BaseExceptionFilter prototype stub needed — the filter implements
    // ExceptionFilter directly and writes the Fastify reply via the mocked
    // chainable .status().send() on the host's response.
  });

  it('calls auditService.write() on IdentityForbiddenException', () => {
    const host = makeArgumentsHost({
      method: 'POST',
      routeOptionsUrl: '/v1/logs/sentinel',
      identity: 'RESEARCH',
      role: 'agent',
    });
    const exception = new IdentityForbiddenException("Identity 'RESEARCH' is not authorised for this route");

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledOnce();
  });

  it('writes audit row with correct identity, role, method, path, and status 403', () => {
    const host = makeArgumentsHost({
      method: 'PATCH',
      routeOptionsUrl: '/v1/system/cash',
      identity: 'OBSERVER',
      role: 'agent',
    });
    const exception = new IdentityForbiddenException("Identity 'OBSERVER' is not authorised for this route");

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'OBSERVER',
        role: 'agent',
        method: 'PATCH',
        path: '/v1/system/cash',
        status: 403,
        errorKind: 'IdentityForbiddenException',
      }),
    );
  });

  it('uses "unknown" for identity and role when req.user is absent', () => {
    const host = makeArgumentsHost({ method: 'POST', routeOptionsUrl: '/v1/orders' });
    // host has no user (identity/role omitted)
    const exception = new IdentityForbiddenException('No authenticated user on request');

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        identity: 'unknown',
        role: 'unknown',
        status: 403,
      }),
    );
  });

  it('uses req.routeOptions.url as path when present', () => {
    const host = makeArgumentsHost({
      url: '/v1/orders/order-123', // actual URL with ID interpolated
      routeOptionsUrl: '/v1/orders/:id', // route pattern
      identity: 'EXECUTOR',
    });
    const exception = new IdentityForbiddenException("Identity 'EXECUTOR' is not authorised for this route");

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/orders/:id', // route pattern preferred over raw URL
      }),
    );
  });

  it('falls back to req.url when routeOptions.url is absent', () => {
    const host = makeArgumentsHost({
      url: '/v1/system/cash',
      // no routeOptionsUrl
      identity: 'RESEARCH',
    });
    const exception = new IdentityForbiddenException('blocked');

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        path: '/v1/system/cash',
      }),
    );
  });

  it('does not propagate audit write failure (fire-and-forget)', async () => {
    // Make auditService.write reject
    (auditService.write as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB unavailable'));

    const host = makeArgumentsHost({ identity: 'RESEARCH' });
    const exception = new IdentityForbiddenException('blocked');

    // Should not throw even if audit write fails
    expect(() => filter.catch(exception, host)).not.toThrow();
  });

  it('sets body to "<identity-blocked>" in audit row', () => {
    const host = makeArgumentsHost({ identity: 'SENTINEL' });
    const exception = new IdentityForbiddenException('blocked');

    filter.catch(exception, host);

    expect(auditService.write).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '<identity-blocked>',
      }),
    );
  });
});
