# ADR-0006 — Localhost-only binding in this phase

**Status:** Accepted
**Date:** 2026-05-08

## Context
The user explicitly chose to keep the service local-only for the rewrite phase. No frontend exists yet; the agents and the `cclaw` CLI all live inside the same `docker compose` network. Public exposure (TLS, CORS, reverse proxy, allowlist) is deferred until a concrete frontend exists.

## Decision
`apps/api` binds `127.0.0.1:7878`. `docker-compose.yml` publishes it only to `127.0.0.1`. No CORS configuration, no TLS in-process, no public allowlist.

`helmet` middleware still emits standard security headers (CSP, no-sniff, frame-deny) so a future reverse proxy doesn't need to add them later.

## Consequences
- **+** Smallest possible attack surface during the rewrite; no need to harden against the public internet.
- **+** A future "expose" phase becomes a reverse-proxy + TLS termination + CORS-allowlist configuration change — no service code changes.
- **−** Anyone with shell access to the host can reach the API. Acceptable: the host is operator-owned and the bearer-token boundary still applies.
- **−** Cross-host operator workflows aren't possible until the expose phase.
- Locked: `apps/api` does not bind `0.0.0.0` or any public address without a superseding ADR.

## Compose addendum (P6, 2026-05-18)

Inside a docker-compose service mesh the NestJS API binds `0.0.0.0` to accept traffic from other services on the internal bridge (apps-worker healthcheck, crypto-claw gateway `cclaw` calls, compose healthcheck probe). Host port exposure remains zero (`ports:` is omitted from the `apps-api` stanza); Caddy continues to be the only host-facing service.

The `API_BIND_ADDRESS` env var controls the bind address (default `127.0.0.1` for standalone / local dev; set to `0.0.0.0` in the compose `apps-api` environment stanza). The boundary established by ADR-0006 is preserved: the API is not reachable from outside the host. The compose network is an isolated bridge — no external traffic reaches the API without going through Caddy → crypto-claw gateway → http://apps-api:7878.
