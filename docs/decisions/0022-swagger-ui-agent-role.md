# ADR-0022 — Swagger UI behind agent role via Fastify `onRequest` hook

**Status:** Accepted
**Date:** 2026-05-11

## Context
SPEC §11 specifies that `/v1/docs` (Swagger UI) and `/v1/openapi.json` (raw spec) are behind `@Roles('agent')`. P1a wired both endpoints via `SwaggerModule.setup()` but did not enforce auth, on the grounds that the API is localhost-only per ADR-0006. The P1a reviewer flagged this as a SPEC §11 deviation worth fixing in P1b (OPEN-R). P1b is the right phase to close it: the rest of the hardening work (audit, throttler, alert envelope) all assumes SPEC §11 is enforced.

Candidates evaluated: (a) enforce via a Fastify `onRequest` hook registered before `SwaggerModule.setup()` mounts the routes — the hook reads the `Authorization` header, calls `IdentityRegistry.lookup`, allows `agent`, returns 401 otherwise; (b) add a SPEC §11 footnote / ADR addendum acknowledging localhost-only deferral and do not enforce until the API leaves localhost. (a) closes the deviation now; cost is ~15 lines plus an integration test. (b) leaves the deviation; cost is one paragraph of doc; risk is the deviation outliving the localhost-only assumption when SPEC §17 or P6 hardening eventually puts the API behind a reverse proxy.

(a) has known implementation friction: `SwaggerModule.setup()` may register routes in a way that doesn't honor application-level Fastify `onRequest` hooks (the routes may be served by `@fastify/static` which has its own internal hook ordering). The Nest `BearerAuthGuard` is a Nest guard, not a Fastify hook, and Swagger's routes aren't exposed to Nest's guard pipeline — that's why P1a had to leave them unguarded in the first place. Empirical testing during P1b is necessary; if the hook doesn't fire on `/v1/docs/*.html`, (b) is the fallback.

## Decision
**Enforce path taken (implemented in the `feat/p1b-receipts-alerts-heartbeat-audit-throttler` PR):** The Fastify `onRequest` hook approach was successfully implemented and verified to intercept Swagger UI routes before they are served.

**Enforce SPEC §11 by registering a Fastify `onRequest` hook on `app.getHttpAdapter().getInstance()` before `SwaggerModule.setup()` runs; the hook short-circuits requests to `/v1/docs*` and `/v1/openapi.json` that lack a valid `agent`-role bearer token with a 401.**

The hook lives in `apps/api/src/swagger-guard.ts` and is wired from `apps/api/src/main.ts`. It reads the `Authorization: Bearer <token>` header, calls a pure `lookupIdentity(token)` function exported from `libs/auth/src/identity-registry.ts` (the same function `BearerAuthGuard` calls — extracted so the two callers don't drift), and returns 401 unless the resolved identity has `role === 'agent'`. The integration test at `tests/integration/security/swagger-guard.spec.ts` covers: no bearer → 401; unknown bearer → 401; `dashboard` role → 401/403; `agent` role → 200 with HTML body.

The fallback path (b) is reserved for one case only: if the Fastify hook is empirically not honored for the Swagger routes after ≤2h of implementor debugging, the implementor flips this ADR's `## Decision` to "Deferred to P6+ (when the API leaves localhost). Until then, the localhost-only bind per ADR-0006 is the de-facto guard," skips the integration test with a reference back to this ADR, and notes the switch in the PR description. The acceptance criterion (SPEC §11 closed or formally deferred) is satisfied either way; the budget cap exists so the implementor doesn't burn the P1b timeline on framework spelunking.

## Consequences
- **+** SPEC §11 deviation closes inside P1b; no addendum debt carried into P2+.
- **+** The shared `lookupIdentity` extraction is reusable for any other pre-Nest hook (static asset routes, future health-probe variants) that needs to consult the identity registry without going through a Nest guard.
- **+** The hook fires before `@fastify/static` reads the asset from disk; unauthenticated callers don't even cause a file-system hit.
- **+** The ≤2h fallback budget prevents the deviation from blocking P1b on a framework limitation we can't fix.
- **−** Identity lookup is invoked from two places (the Nest guard and the Fastify hook) instead of one. Mitigated by extracting the lookup into a pure function in `libs/auth/src/identity-registry.ts`; without that extraction, this ADR would be net-negative.
- **−** The 401 response shape is hand-rolled in the hook (Nest exception filters don't apply to pre-Nest hooks). Slightly inconsistent with the rest of the API's error envelope. Acceptable for two endpoints; documenting in `apps/api/src/swagger-guard.ts` keeps the divergence visible.
- **−** If the fallback path is taken, the deviation persists until P6. Risk that the addendum is forgotten when the API eventually leaves localhost; mitigated by the explicit cross-link from ADR-0006 to this ADR (any future PR that moves the API off localhost has to read both).
- Locked: Swagger UI and `openapi.json` are either behind `@Roles('agent')` (via this hook) or formally deferred via this ADR's documented fallback; no third path. Any future PR that moves the API off localhost must verify which path was taken and, if fallback, close the deferral as part of that PR.

Cross-links: SPEC §11 (the requirement), ADR-0006 (localhost-only binding — the basis for the fallback path), ADR-0009 (per-identity bearer tokens — the registry `lookupIdentity` reads from), ADR-0019 (default-deny route walker — Swagger routes are exempt because they're not Nest-controller methods, but the walker still must not flag them as undecorated), `apps/api/src/main.ts` (where the hook is registered), `apps/api/src/swagger-guard.ts` (the hook implementation), `libs/auth/src/identity-registry.ts` (the shared `lookupIdentity` extraction this ADR depends on).
