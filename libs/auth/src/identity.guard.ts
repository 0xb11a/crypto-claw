import { Injectable, CanActivate } from '@nestjs/common';

/**
 * Identity guard — no-op shim for P1a–P6 (ADR-0009).
 *
 * In P7 this guard will enforce the @Identities(…) decorator,
 * restricting specific routes to a single named identity (e.g., only
 * EXECUTOR may call POST /v1/orders/:id/execute).
 *
 * Until P7 it passes every request through without inspection.
 * It is registered as a global guard alongside BearerAuthGuard and
 * RolesGuard so the P7 flip only removes the "return true" and adds
 * the real enforcement logic.
 */
@Injectable()
export class IdentityGuard implements CanActivate {
  canActivate(): boolean {
    // P7 TODO: read @Identities(…) metadata and enforce identity-level restriction
    return true;
  }
}
