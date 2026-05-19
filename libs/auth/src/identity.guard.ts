import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IDENTITIES_KEY, type IdentitySpec } from './identities.decorator.js';
import type { AuthenticatedUser, IdentityName } from './identity-registry.js';

/** Minimal Fastify request shape used for identity extraction. */
type FastifyRequest = {
  url?: string;
  method?: string;
  routeOptions?: { url?: string };
  user?: AuthenticatedUser;
};

/**
 * Per-identity authorization guard (SPEC §9.2, ADR-0009 addendum, P7).
 *
 * Reads `@Identities(...)` metadata from the handler/class and decides whether
 * `req.user.identity` is authorised to call this route. Behaviour depends on
 * `AUTHZ_SHADOW_MODE`:
 *
 *   1 (default, PR-A): shadow mode — computes deny/allow but only logs
 *     unauthorized access; passes the request. Rate-limited log: one warn
 *     per (identity, method, path) per 60 seconds (avoids log flood).
 *
 *   0 (PR-C cutover): enforce mode — throws ForbiddenException on deny.
 *
 * Guard order (registered in AuthModule):
 *   BearerAuthGuard → RolesGuard → IdentityGuard
 * BearerAuthGuard sets req.user; RolesGuard ensures the role is correct;
 * IdentityGuard then refines to per-identity level.
 *
 * Missing @Identities decorator:
 *   Shadow: logs `identity_decorator_missing` warn; passes.
 *   Enforce: throws ForbiddenException (default-deny).
 *
 * Wildcard `'*'`:
 *   Any authenticated identity passes immediately. Used on read-only GETs
 *   accessible to DASHBOARD (role boundary already enforced by RolesGuard).
 */
@Injectable()
export class IdentityGuard implements CanActivate {
  /**
   * Shadow-mode flag — read once at construction from process.env via the
   * config module. Reading directly from process.env here is allowed:
   * libs/auth/src/auth.module.ts is on the config exception list (eslint.config.js).
   * The value is stored as a boolean to avoid per-request string parsing.
   *
   * We do NOT inject ConfigService here because the guard is instantiated by
   * NestJS before DI is fully wired on the first boot tick. Instead we read the
   * already-validated env value that parseEnv (libs/config) has accepted.
   *
   * eslint-disable-next-line no-restricted-syntax -- process.env allowed in auth.module.ts exception list
   */
  private readonly shadowMode: boolean;

  /**
   * Per-(identity, method, path) rate-limit map for shadow-mode warn logs.
   *
   * Key: `${identity}:${method}:${path}`
   * Value: timestamp (ms) of the last warn emitted for this key.
   *
   * Only one warn line is emitted per 60 seconds per key, preventing log
   * flood during sustained traffic from an out-of-scope identity.
   */
  private readonly shadowRateLimit = new Map<string, number>();

  /** Rate-limit window: 60 seconds in milliseconds. */
  private static readonly RATE_LIMIT_MS = 60_000;

  constructor(private readonly reflector: Reflector) {
    // eslint-disable-next-line no-restricted-syntax -- process.env read allowed in libs/auth (exception list)
    const raw = process.env['AUTHZ_SHADOW_MODE'];
    // Default to shadow mode (1) when not set; any other value is treated per schema.
    this.shadowMode = raw !== '0';
  }

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<IdentitySpec[] | undefined>(IDENTITIES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<FastifyRequest>();
    const user = req.user;
    const method = (req.method ?? 'UNKNOWN').toUpperCase();
    // Fastify stores the matched route pattern under routeOptions.url; fall back to req.url.
    const path = req.routeOptions?.url ?? req.url ?? 'unknown';

    // -----------------------------------------------------------------------
    // Case 1: Missing @Identities decorator
    // -----------------------------------------------------------------------
    if (!allowed || allowed.length === 0) {
      const identity = user?.identity ?? 'unknown';
      const role = user?.role ?? 'unknown';
      this.logShadowEvent('identity_decorator_missing', identity as IdentityName | 'unknown', role, method, path, []);
      if (!this.shadowMode) {
        throw new ForbiddenException('Route is missing @Identities(…) decorator — default-deny');
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Case 2: Missing req.user (BearerAuthGuard should have set it — guard ordering issue)
    // -----------------------------------------------------------------------
    if (!user) {
      // BearerAuthGuard runs first and would have thrown 401; reaching here means
      // something unexpected. Treat as a blocked request.
      if (!this.shadowMode) {
        throw new ForbiddenException('No authenticated user on request');
      }
      return true;
    }

    // -----------------------------------------------------------------------
    // Case 3: Wildcard — any authenticated identity passes
    // -----------------------------------------------------------------------
    if (allowed.includes('*')) {
      return true;
    }

    // -----------------------------------------------------------------------
    // Case 4: Identity is in the explicit allowlist — allow
    // -----------------------------------------------------------------------
    if ((allowed as string[]).includes(user.identity)) {
      return true;
    }

    // -----------------------------------------------------------------------
    // Case 5: Identity is NOT in the allowlist — shadow log or enforce reject
    // Use distinct event names so operator dashboards can tell apart "would-have-
    // been-blocked but passed" (shadow) from "actually blocked → 403" (enforce).
    // Tester found this in P7 PR-A — single event name caused alert fatigue.
    // -----------------------------------------------------------------------
    if (this.shadowMode) {
      this.logShadowEvent('identity_blocked_shadow', user.identity, user.role, method, path, allowed as string[]);
      return true;
    }

    this.logShadowEvent('identity_blocked_enforce', user.identity, user.role, method, path, allowed as string[]);
    throw new ForbiddenException(`Identity '${user.identity}' is not authorised for this route`);
  }

  /**
   * Emit a rate-limited shadow-mode warn via `process.stderr`.
   *
   * We write to stderr instead of using NestJS's Logger to avoid a circular
   * dependency between libs/auth and libs/logger. The output is structured JSON
   * so Pino's transport picks it up in the same log stream.
   *
   * Rate limit: one line per (identity, method, path) per 60 s.
   *
   * @param event - Event name for Pino grep (`identity_blocked_shadow` | `identity_blocked_enforce` | `identity_decorator_missing`)
   * @param identity - Requesting identity
   * @param role - Requesting role
   * @param method - HTTP method
   * @param path - Route path pattern
   * @param allowed - Allowed identities for this route
   */
  private logShadowEvent(
    event: 'identity_blocked_shadow' | 'identity_blocked_enforce' | 'identity_decorator_missing',
    identity: IdentityName | 'unknown',
    role: string,
    method: string,
    path: string,
    allowed: string[],
  ): void {
    const key = `${identity}:${method}:${path}`;
    const now = Date.now();
    const last = this.shadowRateLimit.get(key);

    if (last !== undefined && now - last < IdentityGuard.RATE_LIMIT_MS) {
      // Within rate-limit window — suppress log
      return;
    }

    this.shadowRateLimit.set(key, now);

    const payload = JSON.stringify({
      level: 40, // pino warn level
      time: new Date().toISOString(),
      msg: event,
      event,
      identity,
      role,
      method,
      path,
      allowed,
      shadowMode: this.shadowMode,
    });

    // Write as a single newline-delimited JSON line (NDJSON — pino format).
    process.stderr.write(payload + '\n');
  }

  /**
   * Check whether the guard is in shadow mode (exposed for testing).
   */
  get isShadowMode(): boolean {
    return this.shadowMode;
  }
}
