---
description: Open or list Architecture Decision Records under docs/decisions/.
argument-hint: "[ADR number like 0007 or 7, or slug substring like 'localhost'; omit to list all]"
---

Open or list Architecture Decision Records under `docs/decisions/`.

Argument: `${ARGUMENTS}`.

1. **No argument** — list every `*.md` file in `docs/decisions/` excluding `README.md`. For each, print: `ADR-NNNN — <Status> — <Title>`. Parse Status from the `**Status:**` line in the header block. Mark `Superseded` and `Deprecated` ADRs distinctly so the operator sees the historical record. Sort by ADR number ascending.

2. **Numeric argument (`7`, `0007`, `12`)** — zero-pad to 4 digits and look up `docs/decisions/<NNNN>-*.md`. If found, print verbatim. If not found, say `no ADR matches NNNN`. ADR numbers are never reused; a numeric miss means the ADR doesn't exist.

3. **Slug argument (`localhost`, `prisma`, `bullmq`)** — case-insensitive substring match against filenames. If exactly one matches, print it verbatim. If multiple match, list them as `ADR-NNNN — <Title>` and stop. If none match, say so.

4. **Mixed argument (`0007 rest`)** — treat as numeric first; fall back to slug match if that fails.

The ADR README at `docs/decisions/README.md` documents the conventions: filenames are `NNNN-kebab-name.md`, numbers never reused, format is Context → Decision → Consequences, status values are `Accepted` / `Superseded` / `Deprecated`. Print verbatim if the user asks for the README explicitly (`/adr README`).

Don't paraphrase ADR bodies — they record *why* and *what we gave up*, and the precise wording matters for future supersession.
