# ADR-0001 — TypeScript + NestJS

**Status:** Accepted
**Date:** 2026-05-08

## Context
The legacy code is JavaScript ESM scripts with no shared type system. The rewrite is an entity-driven web service with controllers, services, repositories, DTOs, guards, interceptors, and scheduled jobs. We need a framework whose conventions match this shape so we don't reinvent module wiring, dependency injection, request lifecycle, OpenAPI generation, and validation.

Candidates evaluated: TypeScript + NestJS, TypeScript + Fastify (lean), JS + Fastify, TypeScript + Hono / Effect.

## Decision
**TypeScript + NestJS, with the Fastify HTTP adapter.**

NestJS gives us, out of the box: module/provider DI, controller/service/repository layering, `class-validator` DTOs as the source of truth for request shapes, OpenAPI generation from controller decorators, guard/interceptor composition (auth, audit), `@nestjs/schedule` for cron, `@nestjs/terminus` for health, `@nestjs/throttler` for rate limiting, and a standalone-application mode for `apps/worker` and `apps/scheduler`.

Fastify adapter (over Express) for higher throughput, schema-first validation, and lower memory.

## Consequences
- **+** Conventions are uniform across the team and across modules; new domain modules follow a predictable shape.
- **+** OpenAPI auto-generation lets the SDK + `cclaw` CLI be derived from a single source.
- **+** Standalone-app mode keeps the worker and scheduler in the same monorepo without dragging HTTP overhead.
- **−** NestJS adds ceremony (decorators, modules, providers) the lean alternatives don't. Acceptable cost given the size of the entity surface (14 modules).
- **−** TypeScript compile step in CI; addressed by tsc --build with project references and CI cache.
- Locked: no other framework or language is acceptable for `apps/*` or `libs/*` without a superseding ADR.
