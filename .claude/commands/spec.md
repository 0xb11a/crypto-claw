---
description: Open a numbered section of SPEC.md by section number (e.g., 4 invariants, 9.5 audit log, 14 testing, 18 phasing).
argument-hint: "<section number, e.g., 4 or 9.5 or 18>"
---

Show the requested section of `SPEC.md` verbatim — the spec is the source of truth and the operator wants it as written.

The user's argument is the section number: `${ARGUMENTS}`.

1. **No argument** — print the table of contents (top-level `## ` and `### ` headings from `SPEC.md`) and stop. The current shape spans §1 (Goals) through §19 (Verification).

2. **Section number like `4.1` or `9.5` or `18`** — read `SPEC.md` and print the section content from its heading line (`### 9.5 Audit log — every write` or `## 18. Phasing summary`) until the next sibling-or-higher heading. Print **verbatim**; no paraphrasing, no summarizing.

3. **Top-level number like `9`** — print just §9's intro and a list of its subsections (`§9.1`, `§9.2`, …) so the operator can drill down.

4. **No match** — fall back to a substring search of the spec text. Report any §-numbers where the term appears, in line-number order.

The spec is ~470 lines; never print the whole document.

Common entry points:
- `/spec 4` — invariants (no Prisma outside libs/prisma; OpenAPI is the contract; default-deny; signer-key isolation; LLM loops in entrypoint; config validated at boot)
- `/spec 6` — repo layout (apps/, libs/, sdk/, prisma/, tests/, docker/, docs/)
- `/spec 7` — domain modules (one entity, one module) + 21-table mapping
- `/spec 8` — background jobs (BullMQ + scheduler)
- `/spec 9` — security (authn, authz, validation, rate limit, audit, transport, secret hygiene)
- `/spec 10` — configuration (env vars, Zod schema)
- `/spec 11` — observability (logs, health, audit log, OpenAPI)
- `/spec 14` — testing (unit/integration/e2e/security/shim-parity, coverage targets)
- `/spec 15` — linting & code quality
- `/spec 16` — CI workflows
- `/spec 17` — deployment
- `/spec 18` — phasing summary (P-prep through P7)
- `/spec 19` — verification checks
