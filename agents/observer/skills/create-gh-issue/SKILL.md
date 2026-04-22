# SKILL.md — Create GitHub Issue

## Purpose
Create or update GitHub issues with mandatory duplicate checking. This skill owns the full issue lifecycle — every issue creation MUST go through this skill to prevent duplicates.

## Trigger
Called by the triage skill when a code bug is identified that needs a GitHub issue.

## Preconditions
- `OBSERVER_ISSUES_REPO` env var must be set
- `gh` CLI must be authenticated (done at container startup)

## Procedure

### Step 1: Receive Problem Details

The triage skill provides:
- **Title** — concise description prefixed with `fix: `
- **Body** — structured issue body (summary, error details, system state, suggested investigation)
- **Source** — which script produced the error
- **Chain** — which chain is affected (if applicable)

### Step 2: Fetch All Open Issues

```bash
gh issue list --repo "$OBSERVER_ISSUES_REPO" --state open --limit 50 --json number,title,body,url
```

This returns ALL open issues in the repo. Do NOT filter by label — the repo is dedicated to observer issues.

### Step 3: Analyze for Duplicates (MANDATORY — NEVER SKIP)

Compare the proposed issue against EVERY open issue returned in Step 2. An issue is a duplicate if ANY of these match:

1. **Same script + same error pattern** — e.g., both mention `execute-trade-evm.js` with `proposeTransaction 429`
2. **Same root cause** — e.g., both describe rate limiting on the same chain, even if titles differ
3. **Title describes the same problem** — same script name, same error type, same chain

If you are unsure whether two issues describe the same problem, treat them as duplicates. It is better to comment on an existing issue than to create a duplicate.

### Step 4a: If Duplicate Found — Comment

Add a recurrence comment to the existing issue:

```bash
gh issue comment <NUMBER> --repo "$OBSERVER_ISSUES_REPO" --body "**Recurrence detected**

- **When:** <timestamp>
- **Error:** <latest error message>
- **Frequency:** <count since last comment or creation>
- **New details:** <anything different from the original report>"
```

After commenting, STOP. Do not create a new issue.

### Step 3b: Redaction Audit (MANDATORY — NEVER SKIP)

Before sending any string to `gh issue create` or `gh issue comment`, audit the title AND body for patterns that indicate an unredacted secret slipped through `log.js`'s write-time redaction. `gh` does NOT redact; you are the last line of defense.

Scan for these regex patterns:
- `0x[a-fA-F0-9]{40}` — EVM addresses
- `0x[a-fA-F0-9]{64}` — private keys / tx hashes
- `\bsk-[A-Za-z0-9_-]{20,}` — API keys (Anthropic, OpenAI, etc.)
- `Bearer\s+[A-Za-z0-9_.\-]{20,}` — bearer tokens
- base58 strings of length 32–44 (Solana addresses / keys)

**If ANY pattern matches:**
1. Replace the offending substring with `[REDACTED]` in both title and body.
2. Re-scan once more. If the replacement version is still dirty (e.g., pattern overlaps), STOP — do not call `gh`.
3. Write `observer_log` with `status: "error"` and `summary: "issue body failed redaction audit (pattern: <which>)"`, then `send-alert.js --type system_health --agent observer --message "Redaction audit blocked GitHub issue; see observer_log"`.
4. Treat the redaction leak as itself a high-priority bug: fixing `scripts/redact.js` or the upstream log call is now the follow-up.

Refusing to post is correct behavior. It is far worse to leak a key than to miss filing one issue.

### Step 4b: If No Duplicate — Create Issue

First, get the OpenClaw version:
```bash
openclaw --version
```

Then create the issue. Include the OpenClaw version and observer model in the Environment section:

```bash
gh issue create --repo "$OBSERVER_ISSUES_REPO" --title "fix: <concise description>" --body "## Summary
<one sentence: what broke, what is the impact>

## Error Details
- **Source:** scripts/<name>.js
- **Error:** <error message from logs>
- **Chain:** <chain>
- **Frequency:** <count since first seen>

## System State
- Executor: <ok/emergency>
- Recent failures: <summary>

## Environment
- **OpenClaw:** <version from openclaw --version>
- **Observer Model:** $OBSERVER_MODEL

## Suggested Investigation
- File: scripts/<name>.js
- Area: <function name or error handling section>
- Pattern: <what likely needs to change>"
```

### Step 5: Report Result

After creating or commenting, report what you did:
- Action taken: `created` or `commented`
- Issue number
- Title (if created) or matched issue title (if commented)

## Constraints
- **NEVER skip the duplicate check** — Step 3 is mandatory for every issue
- **NEVER skip the redaction audit** — Step 3b is mandatory for every issue
- **NEVER create an issue without first running Step 2** to fetch all open issues
- Maximum 3 issues created per triage cycle
- **Security:** NEVER include wallet addresses, private keys, API keys, or transaction hashes. Replace with `[REDACTED]`. The redaction audit in Step 3b is the enforcement mechanism.
- If `gh issue list` fails (network error, auth issue), log the failure and skip issue creation for this cycle — do not create issues blind without the dedup check
- If the redaction audit fails twice, STOP and alert — do not post
