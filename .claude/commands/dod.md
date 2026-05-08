---
description: Print a section of docs/dod.md by kind (A–J), or list all kinds.
argument-hint: "[kind letter A–J — omit to list all kinds]"
---

Show the requested section of `docs/dod.md` verbatim. The DoD is a per-PR checklist keyed off the kind of change; reviewers reject PRs that skip an applicable item.

Argument: `${ARGUMENTS}`.

1. **No argument** — list the kinds A–J with their one-line titles parsed from the section headings of `docs/dod.md`. The current shape:
   - `A. Always`
   - `B. Changes that touch invariants or contracts`
   - `C. Changes to the API (controllers, DTOs)`
   - `D. Changes to the database (schema.prisma)`
   - `E. Changes to background jobs (BullMQ processors / scheduler)`
   - `F. Changes to security (auth, audit, rate limit, redaction)`
   - `G. Changes that affect operations (deploy, migrations, secrets, CI)`
   - `H. Changes to agent surface (skill markdown, CLAUDE.md)`
   - `I. Changes during P-prep / P0 / P1 (rewrite scaffolding)`
   - `J. Pre-merge`

2. **Single-letter argument (`A`–`J`, case-insensitive)** — read `docs/dod.md`, find the heading `## <Letter>. ...`, and print its content verbatim from that heading line until the next `## ` heading or end of file. Print **verbatim**; no paraphrasing.

3. **Multi-letter argument (e.g., `CD` or `C,D`)** — print each requested section in order, separated by a blank line.

4. **Anything else** — fall back to a substring match against the section bodies (case-insensitive). Report kind letters where the term appears.

The DoD is a checklist; print the boxes (`- [ ]`) verbatim. Don't rewrite them as prose.
