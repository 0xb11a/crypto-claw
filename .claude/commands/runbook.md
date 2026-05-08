---
description: Open a section of docs/runbook.md by number or keyword, or list all sections.
argument-hint: "[section number like 2, or keyword like 'rotation' — omit to list all]"
---

Open or list sections of `docs/runbook.md`. Operators read runbooks during incidents; never paraphrase or summarize.

Argument: `${ARGUMENTS}`.

1. **No argument** — list every numbered top-level section under `docs/runbook.md` (lines starting with `## `). Print: `<section number>. <title>`. The current shape (P-prep) is:
   - `1. Provisioning a fresh host`
   - `2. Token rotation`
   - `3. Backup (SQLite + Redis snapshots)`
   - `4. Restore from backup`
   - `5. Upgrade (image bump)`
   - `6. Rollback (image downgrade)`
   - `7. Multi-fund deployment`
   - `8. Investigating a failed write (audit log)`
   - `9. Stuck job / queue drain`
   - `10. Emergency stop`

2. **Numeric argument (`1`–`10`)** — print the matched section verbatim, from its `## <N>. <title>` heading until the next `## ` heading or end of file. Print **verbatim**; no paraphrasing, no summarizing.

3. **Keyword argument** — case-insensitive substring match against section titles. If exactly one section matches, print it verbatim. If multiple match, list them and stop. If none match, say so.

Sections marked `[TBD — fills in during PN]` are stubs; print them anyway with the stub marker visible — operators need to know the runbook isn't complete yet.

Don't add commentary; just print what's there.
