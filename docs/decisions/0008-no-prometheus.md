# ADR-0008 — No Prometheus / Grafana / metrics endpoint in this scope

**Status:** Accepted
**Date:** 2026-05-08

## Context
Best-practice web services typically expose Prometheus metrics and ship a Grafana dashboard for SLO tracking. The user explicitly chose to drop both for this rewrite — the operational footprint is small (one host, one operator), and structured logs + audit log + health endpoints already cover the questions they ask.

## Decision
- No `prom-client`, no `/metrics` endpoint.
- No Prometheus or Grafana containers in `docker-compose.yml`.
- No SLO documentation, no burn-rate alerts.
- **Kept:** structured JSON logs via `nestjs-pino`; health endpoints via `@nestjs/terminus` (`/healthz` liveness, `/readyz` readiness); audit log on every write, queryable via `cclaw system audit …`.

## Consequences
- **+** Smaller image, fewer moving parts, less to operate.
- **+** No monitoring sidecar to keep updated.
- **−** No quantitative dashboards. Operator relies on logs and audit queries.
- **−** SLO tracking is informal. Acceptable at single-operator scale.
- Reversibility: a future ADR can re-add `prom-client` and a `/metrics` endpoint additively. Adding it later is a small lift; designing for it now would carry cost we don't need.
