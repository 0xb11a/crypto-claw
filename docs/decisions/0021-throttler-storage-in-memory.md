# ADR-0021 — Throttler storage: in-memory with per-identity tracker

**Status:** Accepted
**Date:** 2026-05-11

## Context
SPEC §9.4 requires rate limiting via `@nestjs/throttler`: 600 req/min for the `agent` role, 60 req/min for `dashboard`, with the quota tracked **per identity** (not per role and not per IP). P1a installed `ThrottlerModule` but did not bind `ThrottlerGuard` globally — the planner deferred enforcement (OPEN-Q4 from P1a). P1b is where the rate limiter actually starts enforcing, which forces two storage decisions to land together: where the counters live, and what key they're bucketed by.

Storage candidates evaluated: (a) `@nestjs/throttler`'s default in-memory `ThrottlerStorageService` (counters in the process heap; per-replica isolation), (b) Redis-backed via `@nestjs/throttler-storage-redis` (centralised counter; correct under horizontal scale). The deployment topology today is `docker compose` with a single API replica (SPEC §3, §17). Redis is already provisioned for BullMQ queues per ADR-0004, but introducing it on every authed request adds a round-trip on the hot path and a failure mode where every request blocks on a degraded Redis. The gain is hypothetical (we don't scale horizontally in P1–P5), the cost is real. SPEC §17's horizontal-scale work, when it lands, is the natural place to revisit.

The tracker key matters as much as the storage. The default `ThrottlerGuard.getTracker(req)` returns `req.ip`, which on a localhost-only deploy (ADR-0006) collapses every identity into one shared bucket — the opposite of what SPEC §9.4 specifies. Per-identity tracking requires overriding `getTracker` to read `req.user.identity` set by `BearerAuthGuard` (ADR-0009).

## Decision
**Use `@nestjs/throttler`'s default in-memory `ThrottlerStorageService` for the entire P1b–P5 window; bind a custom `AppThrottlerGuard` globally via `APP_GUARD` that overrides `getTracker(req)` to return `req.user.identity` with a `req.ip` fallback.**

Two named throttlers register on `ThrottlerModule.forRoot`: `agent` (`ttl: 60_000, limit: 600`) and `dashboard` (`ttl: 60_000, limit: 60`). The guard resolves which named throttler applies from `req.user.role`. The guard registers **after** `BearerAuthGuard` so `req.user.identity` is populated by the time `getTracker` runs. `@SkipThrottle()` is applied to `HealthController.healthz` and `HealthController.readyz` — operational probes that must never be rate-limited. The `req.ip` fallback in `getTracker` is defense-in-depth for any future bypass case where `req.user` is unexpectedly absent on an authed route: per-IP limiting is safer than per-identity = `undefined` = single shared bucket.

## Consequences
- **+** Zero new infrastructure on the authed hot path — the request stays in-process, no Redis round-trip per call, no new failure mode where Redis degradation halts every authed request.
- **+** Per-identity tracking makes the quota meaningful: `RESEARCH` flooding the API cannot exhaust `EXECUTOR`'s budget, matching SPEC §9.4's intent and ADR-0009's per-identity model.
- **+** Migration to Redis-backed storage at P6 is a swap of one DI provider; no API change for callers, no decorator change at handler sites.
- **−** Counters are per-replica. Horizontal scale (P6+) will share state incorrectly until the Redis swap lands. Acceptable for P1–P5: SPEC §3 assumes a single replica.
- **−** Process restart resets all counters. A malicious caller can survive a counter reset, but restarts are observable in operator logs and the legitimate quota window is one minute, so the bypass window is short.
- **−** The named-throttler resolution happens inside the guard; debugging which throttler tripped requires a structured log line that includes the resolved tracker and the named throttler. The implementation must emit that — otherwise on-call sees "429" with no context.
- Locked: no Redis throttler storage in P1b–P5; no per-handler quota overrides shipped in P1b (the two named throttlers are global); the `@SkipThrottle()` allowlist is `healthz` and `readyz` only. P6 revisits storage as part of horizontal-scale readiness.

Cross-links: SPEC §9.4 (rate-limit requirement), SPEC §3 (single-replica topology), SPEC §17 (horizontal-scale phase), ADR-0009 (per-identity bearer tokens — the registry `getTracker` reads from), ADR-0004 (Redis already provisioned for BullMQ — the natural storage target at P6), ADR-0010 (executor-subprocess isolation — the executor doesn't consume API throttler budget because it spawns from BullMQ rather than HTTP-calling the API).
