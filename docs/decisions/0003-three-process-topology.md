# ADR-0003 — API + Worker + Scheduler (3 processes, 1 image)

**Status:** Accepted
**Date:** 2026-05-08

## Context
The legacy system runs everything in one container with shell-loop crons in `entrypoint.sh`. Background work, HTTP, and the LLM-agent invocations all share a single process boundary. A stuck loop blocks the others; there is no separation between request-path code and background work; there is no isolation of secret-bearing operations from read traffic.

Candidates evaluated: monolith (one process), 2-process (api + worker with in-worker scheduler), 3-process (api + worker + scheduler).

## Decision
**Three processes from one image:** `apps/api`, `apps/worker`, `apps/scheduler`. Plus an ephemeral `apps/executor` spawned per order.

- `apps/api` — NestJS HTTP server (Fastify adapter), bind `127.0.0.1:7878`.
- `apps/worker` — NestJS standalone, BullMQ consumer for jobs, plus the long-running approval bot.
- `apps/scheduler` — NestJS standalone, registers cron schedules, enqueues jobs into Redis.
- `apps/executor` — separate small standalone subprocess; the only place signer keys are loaded.

All four are built from the same `Dockerfile` and share `libs/*`; only the `command:` differs in `docker-compose.yml`.

## Consequences
- **+** A stuck job can't block HTTP. A misbehaving HTTP route can't starve background work.
- **+** Per-process resource and security boundaries (e.g., signer-key allowlist on the executor only).
- **+** Independent restart and health checking per concern.
- **−** Three sets of NestJS bootstrap code; mitigated by shared `libs/*` and minimal app-level wiring.
- **−** Slight memory overhead vs. monolith (~3× a small Node baseline). Acceptable on the target host.
- Locked: a fifth process is not added without a superseding ADR.
