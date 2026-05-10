import { SetMetadata } from '@nestjs/common';
import type { IdentityName } from './identity-registry.js';

/** Metadata key for @Identities(...) — read by IdentityGuard (P7). */
export const IDENTITIES_KEY = 'identities';

/**
 * Restrict a route to specific identities (SPEC §9.2 — enabled in P7).
 *
 * In P1a–P6 this decorator is accepted by the ESLint rule and the route
 * walker but the IdentityGuard is a no-op shim, so it has no runtime effect.
 *
 * Usage (P7+):
 *   @Identities('EXECUTOR')  // only the executor identity may call this
 */
export const Identities = (...identities: IdentityName[]) => SetMetadata(IDENTITIES_KEY, identities);
