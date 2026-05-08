---
description: Show current phase per SPEC §18, completed and remaining acceptance items, ADR count, and working-tree state.
---

Print a phase-status report. No code changes, no plan suggestions — status only.

1. **Current phase** — read `SPEC.md` §18 ("Phasing summary"). The phases are `P-prep`, `P0`, `P1`, `P2`, `P3`, `P4`, `P5`, `P6`, `P7`. Determine the current phase by:
   - First, check if `CLAUDE.md` has a `## Current phase` heading; if so, print that line verbatim.
   - Otherwise, infer from the working tree: P-prep is complete when `SPEC.md`, `docs/dod.md`, `.env.runtime.example`, `docs/runbook.md`, and ≥ 1 ADR all exist; P0 is complete when `apps/api/`, `libs/`, `pnpm-workspace.yaml`, and `.github/workflows/pr.yml` exist; etc. Print: `Inferred phase: <X> — <reason>`.

2. **Phase scope (SPEC §18)** — print the SPEC §18 line for the current phase verbatim. Then for each scope item, mark its state with evidence:
   - ✓ done — cite the file / commit / CI run that satisfies it
   - ◯ in progress — cite the partial evidence
   - ✗ not started — say so plainly
   No guessing. If you can't determine state from the working tree, git log, or CI, mark it as "evidence unclear".

3. **ADRs** — list `docs/decisions/*.md` (excluding `README.md`). Print: `ADR-NNNN — <Status> — <Title>`. Flag any ADR with `**Status:** Superseded` or `**Status:** Deprecated` so the operator sees the historical record.

4. **DoD applicability snapshot** — read `docs/dod.md` headings (kinds A–J) and print one line per kind that applies to the current phase (e.g., during P-prep, only §A "always", §B "invariants/contracts", and §I "rewrite scaffolding" apply).

5. **Working state** — print the current branch, commits ahead of `main`, and uncommitted-changes count.

End the report with a one-line summary of "ready to advance / blocked on X / mid-implementation".
