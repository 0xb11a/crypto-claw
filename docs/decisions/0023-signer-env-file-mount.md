# ADR-0023 — Signer key mount: `secrets/signer.env` file, executor-only, never in `process.env`

**Status:** Accepted
**Date:** 2026-05-11

## Context
ADR-0010 locks `apps/executor` as the only process that ever holds signer keys at runtime, and SPEC §4 #4 says api/worker/scheduler MUST boot-fail if `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` is set in their `process.env`. P1c-i is the first PR that actually invokes the executor — and now has to answer where the signer keys live on disk and how the worker passes them to the spawned executor without seeing them itself.

Candidates evaluated: (a) repo-root `.env` — same file the legacy stack uses; works today but `@prisma/client`'s side-effect dotenv load runs at module-import time on every Node process (P1a shipped `apps/api/src/preload.ts` to set `PRISMA_DISABLE_DOTENV=1` for exactly this reason). The worker would need the same preload, and if the file is mounted into the worker container, one stray dotenv call leaves the keys in `process.env`. (b) Docker Compose `secrets:` stanza — keys mounted to `/run/secrets/SAFE_SIGNER_KEY` as individual files; clean per-secret isolation but requires swarm mode for the full semantics, while the operator's topology is plain compose. (c) `secrets/signer.env` file, single `KEY=value` file mounted read-only into the worker only, read at SPAWN time via `fs.readFileSync` (not dotenv), passed to `child_process.spawn`'s `env` block and then forgotten. Choice (c) sidesteps the dotenv-preload trap, works in plain compose, bind-mounts are universally supported, and there is one obvious place for ops/runbook to point at.

## Decision
**Signer keys live in `secrets/signer.env` (single file, `KEY=value` lines, mode 0400), bind-mounted read-only into the `worker` container only at `/run/secrets/signer.env` (path configurable via `SIGNER_ENV_FILE`); the worker reads it at spawn time and passes the keys into the executor child's `env` block after filtering signer-key-shaped vars out of the parent env.**

The reader lives in `libs/execution/src/signer-env-loader.ts`: it `stat`s the file, fails hard in `NODE_ENV=production` if mode is not 0400 or the file is world-readable (warns in dev to ease local development), then parses `KEY=value` lines into a local object. `libs/execution/src/spawn-executor.ts` consumes that object, builds `env: { ...filterParentEnv(process.env), SAFE_SIGNER_KEY, SQUADS_SIGNER_KEY }`, and passes it to `child_process.spawn`. The worker's own `process.env` never holds the keys — the `tests/e2e/signer-isolation.spec.ts` E2E snapshots `process.env` before and after the spawn to assert this. The boot self-check in `libs/config/src/boot-checks.ts` from P0a continues to reject api/worker/scheduler if signer-key vars appear in `process.env`. `secrets/signer.env.example` ships with placeholders and a chmod-0400 comment; `secrets/signer.env` is gitignored. The api and scheduler containers do NOT mount `secrets/` — only the `worker` service in `docker/docker-compose.dev.yml` has the bind mount. After P1c-i, the legacy repo-root `.env` no longer contains signer keys; operators migrate via the runbook.

## Consequences
- **+** One file = one place to rotate; no scattered env-var sources, no dependency on a secrets-manager service for P1.
- **+** Mode 0400 + manual `fs.readFileSync` cleanly avoids the Prisma dotenv-side-effect trap that forced `preload.ts` in P1a.
- **+** Works in plain compose, k8s `Secret` as a file, AWS ECS task-definition secret files — any bind-mount-compatible runtime.
- **+** The "executor-only" property is structurally enforced by the compose mount block (only `worker` mounts `secrets/`) and verified by `tests/e2e/signer-isolation.spec.ts`.
- **−** File-on-disk means anyone with access to the worker container's filesystem at runtime can read the keys. Acceptable for the single-tenant, single-host compose deployment today; revisit if multi-tenancy or shared k8s nodes become a concern.
- **−** Operators must remember `chmod 0400` after editing. Runbook documents this; the load-time mode check fails hard in production and warns in dev.
- **−** Rotation requires a worker restart for the new key to take effect on subsequent jobs; an in-flight executor child keeps the old key it was spawned with. Acceptable for P1c-i. P6 hardening may revisit SIGHUP-triggered re-read if rotation cadence demands it.
- Locked: signer keys live ONLY in `secrets/signer.env`. No `SAFE_SIGNER_KEY` / `SQUADS_SIGNER_KEY` in repo-root `.env`, no Docker Compose `secrets:` stanza, no external secrets-manager dependency in P1–P5. Any future move to k8s `Secret`-via-env or a cloud secrets-manager supersedes this ADR.

Cross-links: ADR-0010 (executor subprocess isolation — the invariant this ADR operationalises), SPEC §4 #4 (signer-key boot self-check), SPEC §9.7 (secret hygiene), SPEC §17 (compose mount points), `libs/execution/src/signer-env-loader.ts` (the loader), `libs/execution/src/spawn-executor.ts` (the consumer), `docker/docker-compose.dev.yml` (the mount), `tests/e2e/signer-isolation.spec.ts` (the structural assertion).

## Addendum (2026-05-13) — Real consumer landed in PR-15

`apps/executor/src/execute-trade-evm.ts` is now the first real consumer of the signer.env mount: it reads `SAFE_SIGNER_KEY` from the env block injected by `spawn-executor.ts` and passes it to the Safe Protocol Kit. The boundary held under multi-process E2E (`tests/integration/security/signer-isolation-multiprocess.spec.ts`): the sentinel key never appeared in worker stdout, stderr, or the audit log across all three test groups (single-Safe isolation, SIGTERM mid-execution, two-Safes parallelism). ADR-0023 status remains Accepted.
