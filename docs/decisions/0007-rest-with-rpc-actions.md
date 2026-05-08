# ADR-0007 — REST with controlled RPC verbs

**Status:** Accepted
**Date:** 2026-05-08

## Context
The legacy CLI surface is RPC-shaped (`get-positions`, `approve-order`, `mark-order-executed`, …). The rewrite is entity-driven, so a pure REST surface (`GET /v1/positions`, `POST /v1/orders/:id/approve`) better expresses the model. But several legacy commands don't map to CRUD — `retry-order`, `mark-order-executed`, `cancel-order` are state transitions, not resource mutations.

Candidates evaluated: pure REST, pure RPC (POST `/v1/<command>`), hybrid (REST for CRUD, RPC actions on resources), GraphQL.

## Decision
**REST resource paths with controlled RPC action verbs.**

- CRUD: `GET /v1/positions`, `POST /v1/positions`, `PATCH /v1/positions/:id`, `DELETE /v1/positions/:id`.
- Actions: `POST /v1/orders/:id/approve`, `POST /v1/orders/:id/reject`, `POST /v1/orders/:id/cancel`, `POST /v1/orders/:id/retry`, `POST /v1/orders/:id/execute`, `POST /v1/positions/:id/close`.
- Computed views: `GET /v1/portfolio/summary`, `GET /v1/market/overview`, `GET /v1/wallets/signals/recent`.
- Listing supports `?limit`, `?cursor`, `?status`, `?since`; response envelope `{data, pagination}`.

All paths under `/v1/`. Errors use `{error: {code, message, details?}}` with codes drawn from a documented enum.

## Consequences
- **+** Maps cleanly to the entity model; controllers are organised by resource.
- **+** Action verbs cover the legitimate non-CRUD transitions without inventing fake resources.
- **+** OpenAPI describes the surface naturally; SDK and `cclaw` shape match.
- **−** Two patterns to learn (resource paths vs. action verbs). Convention: action verbs are sub-paths of the resource and always use POST.
- Locked: no new top-level RPC paths (e.g., `POST /v1/<command>`). Actions are sub-paths of resources only.
