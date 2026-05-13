import { SetMetadata } from '@nestjs/common';
import type { RoleName } from './identity-registry.js';

/** Metadata key for @Roles(...) — read by RolesGuard and the route walker. */
export const ROLES_KEY = 'roles';

/**
 * Declare which roles are allowed to access a handler (SPEC §9.2).
 *
 * Usage:
 *   @Roles('agent')               // write routes
 *   @Roles('agent', 'dashboard')  // read routes
 *
 * Missing @Roles(…) on any handler:
 * - RolesGuard rejects at request time (403).
 * - Boot-time route walker throws on startup.
 * - ESLint rule cclaw/require-roles-on-handlers errors at lint time.
 */
export const Roles = (...roles: RoleName[]) => SetMetadata(ROLES_KEY, roles);
