# ADR-0029 — Per-identity authz: shadow-first, then enforce

**Status:** Accepted
**Date:** 2026-05-19

## Context
ADR-0009 reserved `@Identities(...)` as the per-identity write allowlist mechanism but shipped the guard as a no-op until P7. P7 activates it. The blast radius of the activation is large: a single mis-mapped `@Identities(...)` decorator across the 23-controller surface (or a stale agent token mapping at the gateway) turns into a real-mode 403 the first time a research/sentinel/executor heartbeat hits that route in production. Today's gateway wires every LLM agent through a shared `LOOP_API_KEY` (`docker-compose.yml`), so a naive enforce-flip would 403 every real agent call until per-agent tokens are plumbed (PR-B).

Candidates evaluated: (A) big-bang enforce flip in one PR; (B) shadow-first activation with an env flag, then a separate enforce-flip PR after a soak window; (C) per-route opt-in (gradually decorating routes one-by-one). (A) couples the decorator sweep, the gateway-token plumbing, and the enforce-flip into a single high-risk merge. (C) leaves the system in an indeterminate state for weeks where some routes enforce and others don't, defeating default-deny.

## Decision
**Activate per-identity authz behind a runtime flag (`AUTHZ_SHADOW_MODE`), ship the full controller sweep + guard rewrite in shadow mode (PR-A), plumb per-agent gateway tokens in PR-B, then flip the flag default to enforce in PR-C. The shadow code path is retained after the flip as a runtime kill-switch.**

1. **Flag mechanics.** `AUTHZ_SHADOW_MODE: z.coerce.number().int().min(0).max(1).default(1)` in `libs/config/src/schema.ts`. In shadow (`=1`, PR-A default) the guard computes the allow/deny decision and, on deny, emits one structured `identity_blocked_shadow` warn line per `(identity, method, path)` per 60 seconds via stderr, then passes the request. In enforce (`=0`, PR-C default) the same denial throws `ForbiddenException`. Setting the flag back to `=1` and restarting `apps-api` reverts to log-only behaviour without a code deploy.

2. **WORKER and SCHEDULER ship with empty scope sets.** Neither process makes inbound HTTP calls to `apps/api` today; presenting either token therefore 403s on every route under enforce. Defense-in-depth — if a future PR adds an outbound HTTP call from `apps/worker` or `apps/scheduler`, the resulting 403 is the signal that the scope set needs an explicit entry, not that the boundary should be widened silently.

3. **DASHBOARD uses the `@Identities('*')` wildcard sentinel on read-only routes.** Layered with `@Roles('agent','dashboard')`: the role boundary (GETs only via `@Roles('dashboard')`) is the load-bearing check, and the wildcard keeps the per-identity layer from duplicating the route list. The wildcard is a documented sentinel, not metadata absence — the PR-C ESLint rule errors if `'*'` co-occurs with a non-GET handler.

4. **PR-B (per-agent gateway tokens) is a hard prerequisite for PR-C.** Today every LLM agent shares `LOOP_API_KEY` via the gateway. Flipping enforce without first plumbing `RESEARCH_API_KEY` / `SENTINEL_API_KEY` / `EXECUTOR_API_KEY` / `OBSERVER_API_KEY` into the matching `entrypoint.sh` dispatch sites would 403 every real agent call. The PR ordering (A → B → C, with ≥72 h of shadow observation between B and C) is the contract; revert order is the reverse.

## Consequences
- **+** Decorator-sweep regressions surface as audit-log warn lines, not 403s — operators see the mapping bug before an agent sees a failed request. The 72-hour shadow window between PR-B and PR-C makes a "did we map every route?" question answerable from production telemetry rather than from code review alone.
- **+** Audit-log rows on 403 paths now carry the correct `identity` field (already populated by `audit.interceptor.ts`) — silent-mismap debugging is one `cclaw system audit` query away.
- **+** Retaining the shadow code path after PR-C gives operators a runtime kill-switch (`AUTHZ_SHADOW_MODE=1` + restart) that does not require reverting a PR or pushing a hotfix.
- **−** Three PRs and ≥3 weeks elapsed instead of one merge. Tester, reviewer, and security-auditor run three times. Mitigated by PR-A being purely additive (clean `git revert`) and PR-B being a small env/compose change.
- **−** Shadow-mode warn lines add log volume in production for as long as gateway tokens are still mis-mapped. The per-`(identity, method, path)` Map rate-limit (1/min/key) bounds the flood; the operator runbook documents grepping `event:identity_blocked_shadow` to find the mapping gaps before the enforce flip.
- **−** The runtime kill-switch retained after PR-C means an operator who panics and flips `AUTHZ_SHADOW_MODE=1` silently weakens the security posture. Mitigated by the runbook making the trade-off explicit and by the route-walker's enforce-mode boot-fail on missing `@Identities` remaining active (the walker reads the flag once at boot, not per-request).
- Locked: per-identity authz activation must go through shadow → enforce; a future PR cannot ship a new identity, a new controller, or a flag-default change without producing the equivalent shadow-window evidence. Bypassing the shadow window requires a superseding ADR.
- **Shadow rate-limit Map boundedness:** The `shadowRateLimit` Map in `IdentityGuard` is unbounded over process lifetime but key cardinality is structurally capped by the `(identity, method, path)` key shape (~8 identities × ~8 HTTP verbs × ~70 routes ≈ 4480 entries). Worst-case memory footprint ≈ 36 KB. No eviction is needed at current cardinality. Future maintainers must not expand the key to include user-id or request-id without adding an eviction strategy (LRU cap or TTL sweep), as that would make the Map unbounded under sustained traffic.

Cross-links: SPEC §9.2 (per-identity authz), ADR-0009 (per-identity bearer tokens — the registry this guard reads), ADR-0019 (default-deny route walker — extended by this PR to assert `@Identities` presence), ADR-0018 (audit-log shape — the `identity` field this PR exercises), `libs/auth/src/identity.guard.ts`, `libs/auth/src/identity-scopes.ts`, `libs/config/src/schema.ts` (`AUTHZ_SHADOW_MODE`), `docs/runbook.md` §16 (operator playbook for the shadow→enforce cutover).

## Sanctioned `@Identities('*')` exceptions (P7 PR-C1)

The ESLint rule `cclaw/require-identities-on-handlers` (enabled in PR-C1) errors when
`@Identities('*')` co-occurs with a non-GET HTTP-method decorator UNLESS the route is
listed here as a sanctioned exception. Any future write route with `@Identities('*')`
must be added to this table before the PR is merged.

| Route | HTTP Method | Justification |
|-------|-------------|---------------|
| `POST /v1/alerts/:id/acknowledge` | POST (write) | Human-operator UX: any authenticated actor (agent, dashboard) can acknowledge an alert. The write is low-risk (idempotent, no state machine transition). `@Roles('agent','dashboard')` still enforces the role boundary; `@Identities('*')` prevents the wildcard from including unauthenticated requests. Research agent also calls `cclaw alerts ack` from its heartbeat (via LOOP token today; per-agent token after PR-B), so any narrower allowlist risks a 403 when enforce mode flips. |

Audit procedure (maintained by `security-auditor`): before every PR-C2 (or any future
enforce-mode-sensitive PR), grep all controller files for `@Identities\('\\*'\)` paired
with a non-GET HTTP decorator and verify every match is listed in the table above. Any
unlisted match is a BLOCK-level finding.
