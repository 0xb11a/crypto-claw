# ADR-0004 — BullMQ + Redis for background jobs

**Status:** Accepted
**Date:** 2026-05-08

## Context
The legacy system uses shell `while` loops in `entrypoint.sh` to invoke Node scripts on a schedule. There is no retry policy, no backoff, no concurrency control, no visibility into job state, no idempotency framework, and no distinction between "scheduled" and "long-running" tasks.

Candidates evaluated: BullMQ + Redis, in-process scheduler (`@nestjs/schedule` only), SQLite-backed job table, pg-boss-style approach with a different DB.

## Decision
**BullMQ + Redis 7-alpine.**

`apps/scheduler` registers cron entries with `@nestjs/schedule` and enqueues jobs into BullMQ queues at each tick. `apps/worker` subscribes to those queues with configured concurrency, retry policy, and backoff. The approval bot runs in `apps/worker` as a permanent task (a BullMQ Worker without a schedule).

## Consequences
- **+** Retries with exponential backoff, dead-letter handling, and concurrency control come for free.
- **+** Job state is queryable; tests can assert idempotency by enqueueing twice.
- **+** Separates the "when to run" (scheduler) from the "how to run" (worker), which lets us scale or gate them independently.
- **−** Adds Redis as a runtime dependency (one container, ~10 MB image).
- **−** A new failure mode: Redis unavailable. Mitigated by readiness probe on api/worker/scheduler that waits for Redis ping before reaching ready.
- Locked: ad-hoc `setInterval` or shell-loop schedulers in the new code are forbidden.
