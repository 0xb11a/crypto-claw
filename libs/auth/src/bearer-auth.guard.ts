import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Inject } from '@nestjs/common';
/** Minimal Fastify request type — avoids a direct `fastify` import in this lib. */
type FastifyRequest = { headers: Record<string, string | undefined>; user?: unknown };
import { IdentityRegistry } from './identity-registry.js';

/**
 * Bearer token authentication guard (SPEC §9.1, ADR-0009).
 *
 * Extracts the Authorization header, validates the token against the
 * IdentityRegistry, and sets req.user = { identity, role } on success.
 *
 * Returns 401 if:
 * - No Authorization header is present.
 * - Header is not in "Bearer <token>" format.
 * - Token does not match any known identity.
 *
 * The IdentityRegistry uses constant-time comparison (crypto.timingSafeEqual)
 * to prevent timing attacks (SPEC §9.1).
 */
@Injectable()
export class BearerAuthGuard implements CanActivate {
  constructor(@Inject(IdentityRegistry) private readonly registry: IdentityRegistry) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: unknown }>();

    // Extract Authorization header (Fastify stores headers lowercased)
    const authHeader = (req.headers as Record<string, string | undefined>)['authorization'];
    if (!authHeader) {
      throw new UnauthorizedException('Missing Authorization header');
    }

    // Expect "Bearer <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0]?.toLowerCase() !== 'bearer' || !parts[1]) {
      throw new UnauthorizedException('Malformed Authorization header — expected: Bearer <token>');
    }

    const token = parts[1];
    const user = this.registry.lookup(token);
    if (!user) {
      throw new UnauthorizedException('Invalid bearer token');
    }

    req.user = user;
    return true;
  }
}
