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

## Addendum (2026-05-19) — Per-identity scope sets

P7 PR-A activates the per-identity scope sets that this ADR reserved. The scope sets layer on top of `@Roles(...)`: both must pass. `@Roles(...)` is the coarse agent/dashboard boundary; `@Identities(...)` is the per-identity refinement. ADR-0029 covers the shadow-first → enforce-flip rollout that wraps the activation.

**Single source of truth.** `libs/auth/src/identity-scopes.ts` exports `IDENTITY_SCOPES: Readonly<Record<IdentityName, ReadonlyArray<string>>>`. Each entry is a `'METHOD /path-pattern'` string or the bare wildcard `'*'`. The runtime check is done by `IdentityGuard` reading `@Identities(...)` metadata via `Reflector.getAllAndOverride` (mirrors the `RolesGuard` pattern for class-vs-handler inheritance); `IDENTITY_SCOPES` exists for documentation and for the route-walker's future cross-reference check.

**Per-identity scope intent (one line each):**

- **RESEARCH** — full agent surface: orders (propose/approve/reject/cancel/retry), positions, receipts (read), alerts (incl. `POST /v1/alerts/send`), watchlist, wallets + signals, liquidity, contracts/snapshots, heartbeat, research-log (write) + other agent logs (read), analysis-cache, system reads.
- **SENTINEL** — monitoring + sell-side orders: `POST /v1/orders` (action=sell only, enforced at service layer via `OrdersService.propose()`), `POST /v1/orders/:id/cancel`, positions/receipts/alerts/wallets/heartbeat reads, sentinel-log write, analysis-cache reads, system reads.
- **EXECUTOR** (identity ≠ `apps/executor` subprocess) — `POST /v1/orders/:id/execute`, receipts (read + create), executor-log (write), positions read + `PATCH /v1/positions/:id`, system/cash (`PATCH` for on-chain balance updates), alerts/send, heartbeat. Cannot propose, approve, reject, cancel, or retry orders.
- **OBSERVER** — read-everywhere across orders/positions/receipts/alerts/heartbeat/agent-logs/system, plus observer-log (write) and `POST /v1/alerts/send` (for operational alerts).
- **LOOP** — superset of all four LLM-agent scopes. Covers `entrypoint.sh` background loops (paper-seed, memory-backup, etc.) and retained scripts. In PR-A this is also the token every LLM agent uses (gateway wires `CCLAW_API_TOKEN=${LOOP_API_KEY}`); PR-B narrows LOOP to background-loop use only once per-agent tokens are plumbed.
- **WORKER** — empty scope set. No inbound HTTP from `apps/worker` to `apps/api` today; presenting the token 403s on every route in enforce mode (defense-in-depth).
- **SCHEDULER** — empty scope set. Same reasoning as WORKER.
- **DASHBOARD** — `@Identities('*')` wildcard on read-only GETs. The role boundary (`@Roles('dashboard')` allows GETs only) is enforced by `RolesGuard`; the wildcard avoids duplicating the route list in the per-identity layer.

The `'*'` sentinel is the only wildcard accepted by the decorator (`IdentitySpec = IdentityName | '*'`). Empty arrays and missing decorators are both default-deny in enforce mode; in shadow mode (PR-A) the guard logs `identity_decorator_missing` and passes.

Status: Accepted (unchanged).
