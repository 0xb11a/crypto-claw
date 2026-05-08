---
description: Scan tracked + staged files for accidentally-committed secrets, .env files, signer keys, and credentials.
---

Run a defense-in-depth secrets scan. This complements the pre-commit hook — it catches things already-tracked or otherwise missed.

**Step 1 — tracked-file paths that should never be in version control:**

```bash
git ls-files | grep -E '^(\.env($|\..+$)|\.env\.runtime($|\..+[^e][^x][^a][^m][^p][^l][^e]$)|secrets/(?!.*\.example$)|.+\.session$|.+\.session\.bak$|data/|reports/)' || echo 'OK: no forbidden paths tracked'
```

The `.env.runtime.example` and `secrets/*.example` files are explicitly allowed (the rest of `secrets/` is gitignored, but a defense-in-depth check is cheap).

Anything matched is a critical finding.

**Step 2 — secret patterns in tracked files:**

Scan tracked files for these patterns (don't print the matched value, only `file:line — pattern`):

- API key / secret / token / password assignments: `(api[_-]?key|secret|token|password|passphrase)\s*[:=]\s*["'`][a-zA-Z0-9+/=_-]{16,}["'`]`
- PEM private keys: `-----BEGIN [A-Z ]*PRIVATE KEY-----`
- Common provider prefixes: `sk_live_`, `sk_test_`, `AKIA`, `ghp_`, `gho_`, `ghs_`, `ghu_`, `xoxb-`, `xoxp-`
- **EVM signer keys** (`SAFE_SIGNER_KEY` shape): `0x[a-fA-F0-9]{64}` adjacent to the words `SAFE_SIGNER_KEY`, `signer`, or `private`. Print only the file:line; never echo the matched value.
- **Solana signer keys** (`SQUADS_SIGNER_KEY` shape): base58 strings ≥ 80 chars adjacent to `SQUADS_SIGNER_KEY`, `signer`, or `private`. Same redaction rule.
- API tokens (per SPEC §9.1, 32-byte URL-safe): 32+ char `[A-Za-z0-9_-]{32,}` near `RESEARCH_API_KEY`, `SENTINEL_API_KEY`, `EXECUTOR_API_KEY`, `OBSERVER_API_KEY`, `LOOP_API_KEY`, `WORKER_API_KEY`, `SCHEDULER_API_KEY`, `DASHBOARD_API_KEY`, `CCLAW_API_TOKEN`. Excluding values inside `.env.runtime.example` (literal placeholder values like `change-me-…` are expected).
- Hex-looking 32+ char strings adjacent to `secret`/`token`/`key` words.
- Telegram bot tokens: `\d{8,11}:[A-Za-z0-9_-]{35}`.

**Step 3 — staged diff:**

Apply the same pattern checks to `git diff --cached` so we catch changes about to land. The PreToolUse pre-commit hook in `.claude/settings.json` already blocks staging `.env.runtime` and `secrets/<not-example>`; this is a second pass.

**Step 4 — report:**

Print findings as `file:line — pattern <name>`. Never print the matched value. End with:

- `✓ No secrets detected in tracked or staged content.` if clean.
- `BLOCKER: <count> finding(s); review and remove from history before next push.` if any tracked-secret-file or matched-private-key finding.
- `WARNING: <count> finding(s) in staged diff; unstage and reconsider.` if only staged-diff findings.

Do not auto-remediate. Removing secrets from history requires care (`git filter-repo`, BFG) and operator decisions, and a forced rotation of the leaked credential.
