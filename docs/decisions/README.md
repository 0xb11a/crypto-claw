# Architecture Decision Records

Each file in this directory is a one-page record of a locked architectural decision for the CryptoClaw rewrite. Format: **Context → Decision → Consequences**.

Conventions:
- Filenames are `NNNN-kebab-name.md`, numbered sequentially. Numbers are never reused.
- A new ADR supersedes an old one by stating "Supersedes ADR-NNNN" in the header. Both files stay in the repo; the old file gains a "Superseded by ADR-MMMM" header at the top.
- Status values: **Accepted**, **Superseded**, **Deprecated**.
- An ADR records *why* and *what we gave up*. It is not a how-to. Implementation detail belongs in `SPEC.md` or in code.

When a PR changes a locked decision, the PR must add a new ADR.
