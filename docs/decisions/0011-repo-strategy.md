# ADR-0011 — Long-lived `v2` branch in the existing repo

**Status:** Accepted
**Date:** 2026-05-08

## Context
The rewrite touches every file. We need a strategy that lets the new code be developed and reviewed without breaking the old system, while preserving git history, the `agent-memory` git remote, and Docker tag continuity.

Candidates evaluated:
- (a) Long-lived `v2` branch in `crypto-claw`, periodically rebased from `main`, single squash-merge at P4 cutover.
- (b) Fresh repo `crypto-claw-v2`, migrate at P5.
- (c) Parallel directory inside `crypto-claw` (e.g. `service/`), rename at P4.

## Decision
**(a) — long-lived `v2` branch in `crypto-claw`.**

- `v2` branched from `main` at the start of P-prep.
- Hotfixes land on `main`; `v2` rebases from `main` weekly to absorb them.
- All P0–P3 work lands on `v2` via standard PR flow; CI runs against `v2` head.
- P4 cutover: `v2` is squash-merged into `main` after a full e2e validation run on a staging compose stack.
- Legacy deletion (P5) follows on `main` post-cutover.

## Consequences
- **+** Single source of truth for git history. No "v2 repo" divergence.
- **+** Hotfixes to the legacy system don't get lost.
- **+** Docker tags (`:main`, `:vX.Y.Z`) continue to point at the same registry path.
- **+** The `agent-memory` private remote keeps working unchanged through the cutover.
- **−** Long-lived branches drift; rebase discipline matters. Mitigated by weekly rebases and a CI job that fails the `v2` build if it's > 14 days behind `main`.
- Locked: no second repo, no parallel directory.
