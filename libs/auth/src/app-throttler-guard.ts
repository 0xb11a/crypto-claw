import { Injectable, Logger } from '@nestjs/common';
import { ThrottlerGuard, ThrottlerException } from '@nestjs/throttler';
import type { ExecutionContext } from '@nestjs/common';
import type { AuthenticatedUser } from './identity-registry.js';

/** Minimal Fastify request shape — avoids a direct fastify import. */
type FastifyRequest = {
  headers: Record<string, string | undefined>;
  ip?: string;
  user?: AuthenticatedUser;
  url?: string;
};

/**
 * Per-identity throttler guard (SPEC §9.4, ADR-0021).
 *
 * Overrides the default `getTracker()` to return `req.user.identity` instead of
 * `req.ip`. This ensures each agent identity has its own independent quota
 * bucket: RESEARCH flooding the API cannot exhaust EXECUTOR's budget.
 *
 * Falls back to `req.ip` for any unauthenticated request (defense-in-depth;
 * unauthenticated requests are already rejected by BearerAuthGuard before this
 * guard runs, but per-IP fallback is safer than a single shared bucket).
 *
 * The guard is registered AFTER BearerAuthGuard in APP_GUARD list so that
 * req.user is always populated by the time getTracker() runs (ADR-0021).
 *
 * On 429: emits a structured log line with tracker and identity so on-call
 * engineers can diagnose "429 with no context" (ADR-0021).
 */
@Injectable()
export class AppThrottlerGuard extends ThrottlerGuard {
  private readonly logger = new Logger(AppThrottlerGuard.name);

  /**
   * Return the identity-based tracker key.
   *
   * @param req - Fastify request with optional req.user populated by BearerAuthGuard
   */
  protected override async getTracker(req: FastifyRequest): Promise<string> {
    return req.user?.identity ?? req.ip ?? 'unknown';
  }

  /**
   * Throw ThrottlerException and log the context (ADR-0021: on-call needs context).
   *
   * @param context - NestJS execution context
   * @param _throttlerLimitDetail - Throttler details (not used — logged at debug level by base)
   */
  protected override async throwThrottlingException(
    context: ExecutionContext,
    _throttlerLimitDetail: unknown,
  ): Promise<void> {
    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const tracker = req.user?.identity ?? req.ip ?? 'unknown';
    const role = req.user?.role ?? 'unknown';
    this.logger.warn({
      msg: 'rate_limited',
      tracker,
      role,
      path: req.url ?? '?',
      throttlerName: role === 'dashboard' ? 'dashboard' : 'agent',
    });
    throw new ThrottlerException();
  }
}
