import { Catch, type ArgumentsHost, Injectable } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import { IdentityForbiddenException } from '@cclaw/auth';
import { AuditService } from './audit.service.js';
import type { AuthenticatedUser } from '@cclaw/auth';

/** Minimal Fastify request shape for the filter. */
type FilterRequest = {
  method?: string;
  url?: string;
  routeOptions?: { url?: string };
  user?: AuthenticatedUser;
};

/**
 * Exception filter for IdentityGuard-thrown 403s (P7 PR-C1, auditor suggestion #5).
 *
 * **Problem addressed:**
 * `IdentityGuard.canActivate()` runs in the guard chain, which is invoked BEFORE
 * the NestJS `AuditInterceptor.tap()` observable. When the guard throws a
 * `IdentityForbiddenException`, execution short-circuits before the interceptor's
 * response-path hook fires — so no audit row is written for the 403.
 *
 * **Solution:**
 * A Nest `ExceptionFilter` that catches `IdentityForbiddenException` (a typed
 * subclass of `ForbiddenException`), writes an audit row synchronously (fire-and-
 * forget on the promise), then delegates to the base exception filter to produce
 * the standard 403 HTTP response.
 *
 * Catching only `IdentityForbiddenException` (not bare `ForbiddenException`) keeps
 * service-layer forbidden errors unaffected — they are already handled by the
 * `AuditInterceptor` via the error branch in `tap()`.
 *
 * **Registration:**
 * Wired globally in `apps/api/src/main.ts` via `app.useGlobalFilters(...)` AFTER
 * `NestFactory.create()` so it receives the fully initialised `AuditService` from DI.
 *
 * SPEC §9.2, §9.5, ADR-0018, ADR-0029, P7 PR-C1.
 */
@Injectable()
@Catch(IdentityForbiddenException)
export class IdentityForbiddenFilter extends BaseExceptionFilter {
  constructor(private readonly auditService: AuditService) {
    super();
  }

  catch(exception: IdentityForbiddenException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FilterRequest>();
    // Note: we do not read the response here — the base class handles status/body serialisation.
    // The FilterReply type is kept for documentation but not instantiated to avoid a lint warning.

    const method = (req.method ?? 'UNKNOWN').toUpperCase();
    // Prefer the matched route pattern (Fastify routeOptions.url); fall back to raw URL.
    const path = req.routeOptions?.url ?? req.url ?? 'unknown';
    const user = req.user;
    const ts = new Date().toISOString();

    // Write audit row — fire-and-forget. The filter must not block the response
    // path on a slow write. Failures are silently swallowed per the same convention
    // as AuditInterceptor.writeAudit(). The audit row body is '<blocked>' to avoid
    // logging the request body that was rejected by the guard.
    this.auditService
      .write({
        ts,
        identity: user?.identity ?? 'unknown',
        role: user?.role ?? 'unknown',
        method,
        path,
        body: '<identity-blocked>',
        status: 403,
        latencyMs: 0,
        errorKind: 'IdentityForbiddenException',
      })
      .catch(() => {
        // Audit write failure must not propagate — guard-thrown 403s still return
        // a 403 response regardless of whether the audit row was written.
      });

    // Delegate to the base filter to produce the standard NestJS 403 response.
    // This preserves the Fastify error-serialisation pipeline (exception shape,
    // content-type, status code) and avoids us having to re-implement it.
    super.catch(exception, host);
  }
}
