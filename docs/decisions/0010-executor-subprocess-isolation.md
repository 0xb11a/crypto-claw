# ADR-0010 — `apps/executor` runs as an ephemeral subprocess, not in the API/worker

**Status:** Accepted
**Date:** 2026-05-08

## Context
`SAFE_SIGNER_KEY` and `SQUADS_SIGNER_KEY` are the highest-value secrets in the system — possession means the ability to move funds out of the multisigs. Any process that holds them at runtime is part of their blast radius. Folding execution into a long-running service (api or worker) puts every read endpoint, every job, every dependency into that blast radius.

## Decision
**`apps/executor` is a small standalone subprocess spawned per order by `apps/worker`'s `libs/execution/spawn` helper. It is the only process that loads signer keys.**

- Signer keys live in `secrets/signer.env` (mode 0400, owned by the deploy user).
- The file is mounted only into the `worker` container.
- `apps/api`, `apps/worker`, `apps/scheduler` boot with a self-check that exits if `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` is set in their `process.env`. Defense against config drift.
- `libs/execution/spawn` reads the file at spawn time and pipes the keys into the executor child via `env: { ...filteredParent, SAFE_SIGNER_KEY, SQUADS_SIGNER_KEY }`.
- The executor builds, signs, and submits a single Safe / Squads transaction, prints a JSON receipt to stdout, and exits.

## Consequences
- **+** Signer keys are never in any long-running process env. Crash-dump, env-leak, log-leak, and dependency-supply-chain attacks against api/worker/scheduler do not yield signer access.
- **+** Existing redaction paths in legacy `execute-trade-*.js` are preserved; nothing about that surface changes.
- **−** Per-order `fork()` cost. Negligible at the system's transaction rate.
- **−** Spawn failures and child crashes need careful handling in `libs/execution`. Tests assert receipt parsing and crash handling.
- Locked: signer keys may not appear in `apps/api`, `apps/worker`, or `apps/scheduler` at any time.
