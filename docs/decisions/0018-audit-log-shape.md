# ADR-0018 — Audit log shape: async tap with body sha256 + `libs/logger` redaction

**Status:** Accepted
**Date:** 2026-05-10

## Context
SPEC §9.5 requires every non-GET handler to write an audit row. P1a is the first PR that ships real handlers, so the row shape and the write mechanism need locking before the first migration goes in. Three real choices on shape: (a) full request body in the row, (b) body redacted via the existing `libs/logger/src/redactor.ts` patterns, (c) only metadata + sha256 of the raw body. Three choices on mechanism: (1) synchronous interceptor that blocks the response until the row is written, (2) `tap()` interceptor that fires-and-forgets after the response is sent, (3) sidecar via Redis queue.

(a) leaks signer keys / API tokens / approval reasons containing arbitrary text into the audit table — unacceptable. (c) loses too much context — auditors can't see *what* was approved without the body. (b) is the right middle: redacted body kept inline; sha256 of the *raw* body kept alongside so a body captured out-of-band (e.g., from a legal hold of process logs) can be re-validated against the audit row without storing the secret-bearing original.

(1) couples response latency to disk write; SQLite + WAL still measures in single-digit ms, but the audit write also re-acquires the write lock that the request handler may have just released, doubling effective lock contention. (2) keeps the response path tight; the loss is that an audit failure isn't surfaced to the client. The audit table is the audit; if the audit write fails, that's a separate incident captured in the structured log. (3) introduces a queue dependency for a row write that's already cheap — over-engineering.

## Decision
**Audit rows are written from a `tap()` interceptor after the response stream completes; the row carries a redacted body (via `libs/logger/src/redactor.ts`) plus the sha256 of the canonicalized raw body.**

`libs/audit/src/audit.interceptor.ts` runs on every method tagged `@Audited()`. Captures `req.method`, `req.url`, `req.user.identity`, `req.user.role`, `req.body`, `Date.now()`, the Nest response object via `RxJS tap(...)`. After the response stream completes (success OR error), the interceptor:

1. Computes `body_sha256 = sha256(canonicalize(req.body))` where `canonicalize` is `JSON.stringify` with sorted keys (so key order doesn't change the hash).
2. Computes `body_redacted = libs/logger.redactString(JSON.stringify(req.body))` — same redactor that strips signer keys, bearer tokens, JWT-shaped strings, RPC URLs with creds, and authorization headers from log lines.
3. Writes a `service_audit` row asynchronously via `AuditService.write({...})`. The `tap()` does not block the response.
4. If the write throws, logs the error to the structured logger at `error` level with `audit_write_failed: true` so it's findable. The original request's response is unaffected.

The Prisma model:

```prisma
model ServiceAudit {
  id            String   @id @default(cuid())
  ts            DateTime @default(now())
  identity      String
  role          String
  method        String
  path          String
  bodySha256    String   @map("body_sha256")
  bodyRedacted  String?  @map("body_redacted")
  status        Int
  latencyMs     Int      @map("latency_ms")
  errorKind     String?  @map("error_kind")
  @@index([identity, ts])
  @@index([path, ts])
  @@map("service_audit")
}
```

ESLint rule `cclaw/require-audited-on-mutating-handlers` (shipped in this PR under `tools/eslint-plugin-cclaw/`) errors if any non-GET handler in `apps/**` or `libs/modules/**` lacks `@Audited()`. Two-layer enforcement: the lint rule catches it at PR time, and the runtime route walker (ADR-0019) catches missed cases at boot. The ESLint rule is the primary defense; the route walker is the safety net.

## Consequences
- **+** Auditors see what changed without the audit table itself becoming a secret store; redacted body inline + sha256 of the raw body keeps forensic re-validation possible.
- **+** Response latency stays tight because the audit write is fire-and-forget — no doubling of SQLite write-lock contention.
- **+** Two-layer enforcement (lint + boot walker) makes "I forgot to add `@Audited()`" a CI failure, not an undetectable hole.
- **−** A failed audit write produces a log entry but does NOT fail the request — auditors must monitor the log channel for `audit_write_failed: true` events. P1b's ops dashboard adds an alert on this.
- **−** The redactor must be kept current; if a new secret pattern emerges, both the redactor and the audit-redactor tests need updates in lockstep — `libs/audit` tests assert against current redactor patterns and will fail if a new pattern is introduced upstream without the test update.
- Locked: no audit row outside this shape; no synchronous audit write; no third-party audit sink in scope.

Cross-links: SPEC §9.5 (audit log requirement), SPEC §11 (logging), ADR-0019 (the route walker that catches missed `@Audited`), `libs/logger/src/redactor.ts` (the redactor patterns this depends on).
