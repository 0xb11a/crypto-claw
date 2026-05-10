import { Injectable, NestInterceptor, ExecutionContext, CallHandler, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, tap } from 'rxjs';
import { AuditService } from './audit.service.js';
import { AUDITED_KEY } from '@cclaw/auth';
import type { AuthenticatedUser } from '@cclaw/auth';

/** Minimal Fastify request type — avoids a direct fastify import. */
type AuditRequest = {
  method: string;
  url: string;
  routerPath?: string;
  body?: unknown;
  user?: AuthenticatedUser;
};

/** Minimal Fastify reply type. */
type AuditReply = { statusCode: number };

/**
 * Global audit interceptor (SPEC §9.5, ADR-0018).
 *
 * Fires on every controller method decorated with @Audited().
 * Uses RxJS tap() to write the audit row AFTER the response completes
 * (fire-and-forget — does not block the response path).
 *
 * If the audit write fails, the error is logged at 'error' level with
 * audit_write_failed: true, but is NOT propagated to the caller.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  private readonly logger = new Logger(AuditInterceptor.name);

  constructor(
    private readonly auditService: AuditService,
    private readonly reflector: Reflector,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    // Check if the handler is decorated with @Audited()
    const isAudited = this.reflector.getAllAndOverride<boolean | undefined>(AUDITED_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!isAudited) return next.handle();

    const req = context.switchToHttp().getRequest<AuditRequest>();
    const reply = context.switchToHttp().getResponse<AuditReply>();
    const startMs = Date.now();
    const ts = new Date().toISOString();
    const method = req.method.toUpperCase();
    const path = req.url ?? req.routerPath ?? '';
    const body = (req.body as unknown) ?? null;
    const user = req.user;

    return next.handle().pipe(
      tap({
        next: () => {
          const latencyMs = Date.now() - startMs;
          const status = reply.statusCode ?? 200;

          // Fire-and-forget
          this.writeAudit({
            ts,
            identity: user?.identity ?? 'unknown',
            role: user?.role ?? 'unknown',
            method,
            path,
            body,
            status,
            latencyMs,
          });
        },
        error: (err: unknown) => {
          const latencyMs = Date.now() - startMs;
          const status = (err as { status?: number })?.status ?? 500;
          const errorKind = (err as { constructor?: { name?: string } })?.constructor?.name ?? 'Error';

          this.writeAudit({
            ts,
            identity: user?.identity ?? 'unknown',
            role: user?.role ?? 'unknown',
            method,
            path,
            body,
            status,
            latencyMs,
            errorKind,
          });
        },
      }),
    );
  }

  private writeAudit(input: {
    ts: string;
    identity: string;
    role: string;
    method: string;
    path: string;
    body: unknown;
    status: number;
    latencyMs: number;
    errorKind?: string;
  }): void {
    this.auditService.write(input).catch((err: unknown) => {
      // Log the failure but do not propagate — audit writes must not affect responses
      this.logger.error({ err, audit_write_failed: true }, 'Failed to write audit row');
    });
  }
}
