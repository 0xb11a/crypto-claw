import { Catch, type ArgumentsHost, type ExceptionFilter, Injectable } from '@nestjs/common';
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

/** Minimal Fastify reply shape for the filter — avoids depending on the fastify types here. */
type FilterReply = {
  status: (code: number) => FilterReply;
  send: (payload: unknown) => unknown;
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
export class IdentityForbiddenFilter implements ExceptionFilter {
  constructor(private readonly auditService: AuditService) {}

  catch(exception: IdentityForbiddenException, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const req = ctx.getRequest<FilterRequest>();
    const reply = ctx.getResponse<FilterReply>();

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

    // Send the 403 response directly. We do not extend BaseExceptionFilter
    // because that requires HttpAdapterHost injected via DI; we instantiate
    // this filter manually in apps/api/src/main.ts after AuditService is
    // resolved, so the simpler approach is to write the Fastify reply here.
    // Shape matches Nest's default ForbiddenException response body.
    const body = exception.getResponse() as Record<string, unknown> | string;
    const payload =
      typeof body === 'string'
        ? { statusCode: 403, message: body, error: 'Forbidden' }
        : { statusCode: 403, error: 'Forbidden', ...body };
    reply.status(403).send(payload);
  }
}
