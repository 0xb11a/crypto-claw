# ADR-0005 — `cclaw` CLI generated from OpenAPI

**Status:** Accepted
**Date:** 2026-05-08

## Context
Agents today invoke 44 standalone CLI scripts directly. Agent skill markdown holds 197 references to specific script paths and flag shapes. After the rewrite, those references must point at the new API. We need a single, discoverable, low-churn surface.

Candidates evaluated: a generated TS SDK plus a `cclaw` CLI wrapping it; raw `curl` invocations in agent markdown; an MCP server as the agent surface.

## Decision
**Generated TS SDK + `cclaw` Commander.js CLI; OpenAPI is the source of truth.**

NestJS controllers + DTOs generate `openapi.json`. `openapi-typescript-codegen` generates `sdk/generated/`. `sdk/cclaw/` is a thin Commander wrapper that exposes resource-shaped subcommands (`cclaw positions list --status open`). The CLI reads its token from `CCLAW_API_TOKEN` and writes JSON to stdout.

## Consequences
- **+** Single import surface for agent markdown; rewrites are a deterministic mapping table.
- **+** API evolution is reflected in `cclaw` automatically via codegen; agents never see stale shapes.
- **+** Type-safe SDK for any future TS frontend without re-engineering.
- **+** OpenAPI doc itself is a useful artifact (Swagger UI at `/v1/docs`).
- **−** CI must enforce that committed `sdk/generated/` matches the regenerated output (drift gate).
- **−** A pre-existing baseline (`tests/shim-parity/baseline/`) is required to assert byte-for-byte parity during P1–P4.
- Locked: agents do not call `curl` or other ad-hoc HTTP clients; `cclaw` is the only path.
