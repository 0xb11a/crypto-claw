# ADR-0019 — Default-deny route walker: boot-time enforcement of `@Roles` + `@Audited`

**Status:** Accepted
**Date:** 2026-05-10

## Context
SPEC §4 #3 says default-deny on every route — explicit `@Roles(...)` and a typed body/query DTO on every controller method, plus `@Audited()` on every non-GET handler per SPEC §9.5. The risk is silent regression: a coder writes `@Get('/foo')` without `@Roles(...)` and the framework defaults to "publicly accessible" because Nest itself doesn't ship a default-deny posture. By the time someone notices, a private route has been exposed. The same risk applies to `@Audited()` — a non-GET handler without it produces no audit row, and the gap is invisible without dedicated tooling.

Three places this can be caught: (1) at write time via an editor lint warning, (2) at PR review time via CI lint, (3) at boot time via runtime introspection. (3) is necessary because (1) is local to whoever has the editor configured and (2) can be bypassed if the lint rule is disabled or if a meta-decorator hides the issue. (3) catches every code path that reaches `NestFactory.create()`. (1) is out of scope because it requires per-developer editor config we can't enforce. (2) and (3) are both required and complementary: (2) catches issues fastest and produces a clear file/line; (3) catches issues that (2) missed (e.g., decorators applied dynamically, unusual factory patterns) and refuses to start the service.

## Decision
**Two-layer enforcement, both shipped in P1a: a project-local ESLint plugin that errors on undecorated handlers, plus a boot-time route walker that refuses to start the service if any route lacks `@Roles(...)` or any non-GET handler lacks `@Audited()`.**

1. **CI lint rule** — a project-local ESLint plugin at `tools/eslint-plugin-cclaw/` exporting two rules:
   - `cclaw/require-roles-on-handlers` — AST inspects class methods inside any class decorated `@Controller(...)`. If the method is decorated with any of `@Get/@Post/@Put/@Patch/@Delete/@All/@Head/@Options` and is NOT decorated with `@Roles(...)`, error.
   - `cclaw/require-audited-on-mutating-handlers` — same target set; if the method is decorated with any non-GET HTTP method decorator and is NOT decorated with `@Audited()`, error.
   - Both rules run on `apps/**/*.ts` and `libs/modules/**/*.ts` via `eslint.config.js` overrides.

2. **Boot-time route walker** — `apps/api/src/bootstrap.ts` registers an `onApplicationBootstrap` lifecycle hook (or runs synchronously in `bootstrap()` before `app.listen()`). The walker:
   - Iterates `app.get(MetadataScanner)` over every controller method.
   - For each method, reads `Reflect.getMetadata('roles', handler)` and `Reflect.getMetadata('audited', handler)`.
   - Throws (refusing to start) if any handler lacks `roles` metadata.
   - Throws if any non-GET handler lacks `audited` metadata.
   - Error message format: `[boot] route <METHOD> <path> on <ControllerClass>#<method> missing @Roles(...)` (or `@Audited()`). Mirrors the SPEC §4 #6 boot-fail error format established for config validation.

The runtime walker uses `process.exit(78)` (sysexits `EX_CONFIG`) on failure, matching the existing config-validation boot-fail in `libs/config/src/boot-checks.ts` so operators see one consistent boot-failure exit code.

The two layers are NOT redundant — they protect different things. The lint rule's failure mode is "developer ignored CI"; the walker's failure mode is "decorator applied at runtime through a code path the lint rule didn't see." Production deployments rely on the walker as the last line of defense.

## Consequences
- **+** A missing `@Roles(...)` or `@Audited()` is impossible to land in production; the CI lint rule and the boot walker close the two distinct failure modes.
- **+** The boot-fail error format is identical to other boot-time failures, so the operator runbook has one paragraph for all three (config invalid, signer key present, route undecorated).
- **+** The lint rule produces a clear message at the file/line where the decorator is missing, accelerating fixes.
- **−** The boot-time walker adds ~20–50ms to startup depending on controller count; immaterial.
- **−** ESLint plugin development is a small ongoing cost — every new HTTP-method decorator imported needs the rule's allowlist updated; this is a one-line change but easy to forget.
- Locked: no controller method without `@Roles(...)`; no non-GET handler without `@Audited()`; the boot walker cannot be disabled without a SPEC change.

Cross-links: SPEC §4 #3 (default-deny invariant), SPEC §9.5 (audit log requirement), SPEC §15 (lint policy), ADR-0009 (per-identity bearer tokens — the role registry the walker validates against), ADR-0018 (audit log shape — the metadata the walker enforces).

## Addendum (2026-05-19) — `@Identities(...)` walker check

P7 PR-A extends `RouteWalkerService` with a third metadata assertion: every handler must carry `@Identities(...)` (the singular `'*'` wildcard is accepted). The check mirrors the existing `@Roles(...)` / `@Audited()` walks (`Reflector.getAllAndOverride` against `IDENTITIES_KEY`, same controller-method enumeration, same error-message format `[boot] route <METHOD> <path> on <ControllerClass>#<method> missing @Identities(...)`).

The check is mode-aware via the same `AUTHZ_SHADOW_MODE` flag introduced in ADR-0029:

- **Shadow mode (PR-A, `AUTHZ_SHADOW_MODE=1`)** — emit a `[warn]` line to stderr per missing-decorator hit; do NOT add to the boot-fail violations list. Operators see the gaps in the apps-api log stream and fix them before the enforce flip.
- **Enforce mode (PR-C, `AUTHZ_SHADOW_MODE=0`)** — add to the violations list, refuse to start, exit 78. Identical boot-fail posture to the existing `@Roles` / `@Audited` checks.

The walker is backstopped at the lint layer by `tools/eslint-plugin-cclaw/rules/require-identities-on-handlers.js` (shipped disabled in PR-A, enabled error-level in PR-C) and at the CI layer by `scripts/ci/check-identities-coverage.mjs` (active in PR-A so coverage stays at 100% across the shadow window). The three layers protect different failure modes per the original ADR rationale: lint catches issues at the file/line, CI grep catches lint bypasses, and the walker catches dynamic decorator paths the static checks didn't see.

Status: Accepted (unchanged).
