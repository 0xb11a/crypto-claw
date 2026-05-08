# ADR-0009 — Per-identity bearer tokens (not one shared agent token)

**Status:** Accepted
**Date:** 2026-05-08

## Context
The two-role boundary (agent / dashboard) is the headline auth model. But within the agent role we have four named LLM agents (research, sentinel, executor, observer) plus the deterministic loops (`apps/worker`, `apps/scheduler`, the legacy `entrypoint.sh` loops during transition). Treating them all under one shared token makes audit logs less useful and forecloses a useful future hardening: per-identity write allowlists.

## Decision
**One bearer token per identity. All identities map to role `agent` for now.**

Identities: `RESEARCH`, `SENTINEL`, `EXECUTOR`, `OBSERVER`, `LOOP`, `WORKER`, `SCHEDULER`, plus `DASHBOARD` (role `dashboard`, RO; no consumer in this phase).

- Tokens are 32-byte URL-safe random strings, mounted from `.env.runtime`.
- The auth guard sets `req.user = {identity, role}`. Identity flows into the audit log.
- An `IdentityGuard` shim ships in P1 as a no-op. P7 enables it: routes can declare `@Identities('EXECUTOR')` to lock writes to a specific token.

## Consequences
- **+** Audit log captures who wrote what.
- **+** Future hardening (P7) is a per-route metadata change, not a re-tokening exercise.
- **+** Token rotation can be granular (rotate the `EXECUTOR` token without touching the others).
- **−** More tokens to manage in `.env.runtime`. Mitigated by the `.env.runtime.example` file and a setup script in `docs/runbook.md`.
- Locked: no shared "agent token" anywhere in the system.
