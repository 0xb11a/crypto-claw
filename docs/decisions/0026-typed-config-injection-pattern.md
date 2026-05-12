# ADR-0026 — Typed config injection pattern (per-field accessors, no bare-key reads)

**Status:** Accepted
**Date:** 2026-05-13

## Context
SPEC §4 #6 mandates a Zod-validated config at boot: every consumed env var passes through `libs/config/src/schema.ts` and the process boot-fails on any drift. `@nestjs/config`'s `ConfigService.get<T>('')` silently returns `undefined` when called with an empty-string key — the type parameter is honoured at compile time but the runtime lookup has no path to resolve, so the typed shape collapses to `undefined` without throwing. P1b hit this in auth bearer-key resolution; P1c-i hit it again in `POST /orders/:id/execute`, which 500'd because per-field reads had been folded behind an undefined aggregate. The failure mode is invisible: TypeScript sees a typed `AppConfig`, runtime sees `undefined.someField`, the error is a `TypeError` far from the misuse. Candidates evaluated: (a) one aggregate `get<AppConfig>('')` per consumer, treating the schema as a typed bag — the very pattern that bit us twice. (b) per-field `get<T>('FIELD_NAME')` at every call site — verbose but each call has a real key to resolve. (c) switch to `getOrThrow` everywhere — stricter than we want today since some fields are legitimately optional.

## Decision
**Every `configService.get` call MUST name a specific schema field; aggregate access via empty-string key, or via a top-level type parameter with no path argument, is banned. The canonical pattern is `configService.get<string>('FIELD_NAME')` with explicit type narrowing at the call site and string-normalisation (`=== 'true'` for booleans) for fields read as strings from `process.env`.**

The Zod schema in `libs/config/src/schema.ts` remains the single source of truth for field shape and required-ness; this ADR governs the *access* discipline, not the schema itself. A future ADR may tighten further by mandating `getOrThrow` for required fields once the migration settles.

## Consequences
- **+** The typed-schema-or-nothing invariant from SPEC §4 #6 holds at every read site; an undefined return now requires a named field genuinely missing from the schema, which boot validation already catches.
- **+** Regressions are mechanically preventable: an ESLint `no-restricted-syntax` rule matching `CallExpression[callee.property.name='get'][arguments.0.value='']` fails lint on the empty-string bug shape. The coder lands the rule in PR-A.
- **+** Call-site reads grep cleanly — `configService.get<.*>('FIELD_NAME')` shows exactly which fields each consumer depends on, useful for schema-change blast-radius checks.
- **−** More verbose at consumption sites: one `.get` per field rather than one destructure of an aggregate. Acceptable price for the invariant.
- **−** Four known offenders migrate in PR-A: `apps/worker/src/processors/execute-order.processor.ts`, `libs/health/src/executor-health.indicator.ts`, `libs/health/src/redis-health.indicator.ts`, `libs/modules/heartbeat/src/idleness.service.ts`. Any consumer added after this ADR MUST follow the per-field pattern from the first commit.
- **−** Open: a future ADR may switch required-field reads to `getOrThrow`. Deferred until the per-field migration has settled and we have a clean baseline to enforce against.
- Locked: no `configService.get<T>('')` and no aggregate-typed `configService.get<AppConfig>()` calls anywhere in the new stack. The lint rule is the structural enforcement; this ADR is the *why*.

Cross-links: SPEC §4 #6 (Zod-validated config at boot — the invariant this ADR protects), `libs/config/src/schema.ts` (the schema this ADR governs access to), ADR-0009 (per-identity bearer tokens — the P1b consumer whose first encounter with this bug forced the convention).
