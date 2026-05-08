# Definition of Done — Per-PR Checklist

Every PR must satisfy every applicable item in this list. The checklist is keyed off the *kind* of change. Reviewers reject PRs that skip an applicable item.

---

## A. Always

- [ ] **Tests added or updated.** Every code change has a test that fails before the change and passes after. Untested code does not merge.
- [ ] **`npm run lint && npm run test:unit && npm run test:integration` green locally** before opening review.
- [ ] **No secrets in the diff.** `pre-commit-check.ts` runs in pre-commit; CI runs trufflehog over the full tree.
- [ ] **Conventional commit subject** (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `ci:`, `build:`, `perf:`). `release-please` consumes these.
- [ ] **PR description states the change in one sentence and the *why* in one sentence.** Link issues. Note any user-visible behavior change.

## B. Changes that touch invariants or contracts

- [ ] **`SPEC.md` updated in the same PR** if any invariant, security boundary, or public contract changes.
- [ ] **A new ADR added under `docs/decisions/`** if the change locks or unlocks a decision (e.g., picking a new tool, changing the topology, redefining the role boundary). Old ADRs gain "Superseded by ADR-NNNN" headers; they are not deleted.

## C. Changes to the API (controllers, DTOs)

- [ ] **OpenAPI regenerated.** `pnpm run build:openapi` produces a delta to `sdk/generated/openapi.json`; the delta is committed. CI's OpenAPI drift gate fails otherwise.
- [ ] **SDK regenerated.** `pnpm run build:sdk` produces a delta to `sdk/generated/`; committed. CI's SDK drift gate fails otherwise.
- [ ] **`cclaw` updated** if the change introduces new commands or breaks existing ones. Commands renamed without deprecation require a migration note in the PR body.
- [ ] **Every non-GET handler carries `@Audited()`.** Lint rule enforces.
- [ ] **Every controller method has explicit `@Roles(...)` and a typed body/query DTO.** Boot check enforces.

## D. Changes to the database (schema.prisma)

- [ ] **Migration file generated and committed.** `pnpm prisma migrate dev --name <descriptive>` produces it.
- [ ] **`prisma migrate diff` clean.** CI's schema drift gate runs this.
- [ ] **Destructive migrations carry an explicit `// DESTRUCTIVE: <reason>` comment** in the SQL and a corresponding note in the PR body. Pre-deploy CI gate fails otherwise.
- [ ] **Affected repository updated**, with tests covering the new shape.
- [ ] **`prisma/seed.ts` updated** if the migration requires data backfill.

## E. Changes to background jobs (BullMQ processors / scheduler)

- [ ] **Job is idempotent.** A test runs the processor twice with the same input and asserts the DB shape is unchanged after the second run.
- [ ] **Backoff and retry policy are explicit** in the BullMQ queue registration.
- [ ] **Cron entry in `apps/scheduler/src/schedules/`** if the job is scheduled.
- [ ] **Health check updated** if the job's liveness affects readiness.

## F. Changes to security (auth, audit, rate limit, redaction)

- [ ] **Security tests cover the change.** `tests/integration/security/`.
- [ ] **No new code reads `process.env` directly.** All config goes through `libs/config`.
- [ ] **No token, signer key, or RPC URL with creds appears in any new log path.** Add to `libs/logger` redactor if a new pattern emerges.

## G. Changes that affect operations (deploy, migrations, secrets, CI)

- [ ] **`docs/runbook.md` updated** for any operator-visible change.
- [ ] **`.env.runtime.example` updated** if a new env var is required, with one-line documentation.
- [ ] **`secrets/signer.env.example` updated** if a new secret applies (rare).
- [ ] **CI workflow updated** if a new gate is needed.

## H. Changes to agent surface (skill markdown, CLAUDE.md)

- [ ] **`/audit-instructions` clean.** Run after the change; commit any consistency fixes in the same PR.
- [ ] **`cclaw` mapping table reviewed** if `cclaw` commands changed (only relevant during P4 cutover and after).

## I. Changes during P-prep / P0 / P1 (rewrite scaffolding)

- [ ] **Old code untouched** if it's still in service. New code lives alongside.
- [ ] **`tests/shim-parity/baseline/` byte-diff clean** for any module migrated under P1–P3.

## J. Pre-merge

- [ ] All branch-protection checks green.
- [ ] At least one approving review.
- [ ] No unresolved review comments.
- [ ] Squash-merge by default; only branch-merge for the P4 cutover squash from `v2`.
