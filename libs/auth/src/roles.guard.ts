import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from './roles.decorator.js';
import type { AuthenticatedUser, RoleName } from './identity-registry.js';
/** Minimal Fastify request type — avoids a direct `fastify` import in this lib. */
type FastifyRequest = { user?: AuthenticatedUser };

/**
 * Role-based authorization guard (SPEC §9.2, ADR-0009).
 *
 * Reads @Roles(...) metadata from the handler and class.
 * If roles metadata is present, rejects 403 if req.user.role is not in
 * the allowlist.
 *
 * Missing @Roles(…) → guard rejects (default-deny at request time).
 * This is defence-in-depth: the ESLint rule catches it at lint time and the
 * boot walker catches it at startup, but this guard ensures no request can
 * slip through at runtime even if those defences are bypassed.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // Merge class-level and handler-level roles (handler takes precedence)
    const roles = this.reflector.getAllAndOverride<RoleName[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // No @Roles decorator → default-deny
    if (!roles || roles.length === 0) {
      throw new ForbiddenException('Route has no @Roles(…) decorator — default-deny');
    }

    const req = context.switchToHttp().getRequest<FastifyRequest & { user?: AuthenticatedUser }>();
    const user = req.user;

    // BearerAuthGuard should have run first and set req.user
    if (!user) {
      throw new ForbiddenException('No authenticated user on request');
    }

    if (!roles.includes(user.role)) {
      throw new ForbiddenException(`Role '${user.role}' is not authorized for this route`);
    }

    return true;
  }
}
