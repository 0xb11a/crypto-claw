import { SetMetadata } from '@nestjs/common';
import type { IdentityName } from './identity-registry.js';

/** Metadata key for @Identities(...) — read by IdentityGuard (P7). */
export const IDENTITIES_KEY = 'identities';

/**
 * Identity spec — a named identity or the `'*'` wildcard sentinel.
 *
 * `'*'` means "any authenticated identity may call this route".
 * It is used on read-only GET routes that allow the DASHBOARD role so that
 * the wildcard can be written once rather than listing all 8 identity names
 * (ADR-0009 addendum, plan Decision 3/4).
 *
 * Wildcard caveats (PR-C ESLint rule will enforce):
 * - `@Identities('*')` must NOT appear on a route that also has `@Roles('agent')`
 *   with a non-GET HTTP method — that would create an unexpectedly permissive
 *   combination. Route-walker will warn on this pattern in PR-C.
 */
export type IdentitySpec = IdentityName | '*';

/**
 * Restrict a route to specific identities (SPEC §9.2, ADR-0009 — enabled in P7).
 *
 * In PR-A (shadow mode, AUTHZ_SHADOW_MODE=1) the guard reads this metadata,
 * computes allow/deny, but only logs unauthorized access — it does not reject.
 * In PR-C (enforce mode, AUTHZ_SHADOW_MODE=0) the guard rejects with 403.
 *
 * Usage:
 *   @Identities('EXECUTOR')           — only the EXECUTOR identity
 *   @Identities('RESEARCH', 'LOOP')   — RESEARCH or LOOP
 *   @Identities('*')                  — any authenticated identity (wildcard)
 */
export const Identities = (...identities: IdentitySpec[]) => SetMetadata(IDENTITIES_KEY, identities);
