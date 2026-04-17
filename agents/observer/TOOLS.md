# TOOLS.md — Observer Agent Tools

## General Notes
- All scripts output JSON to stdout. Parse with `jq` or read directly.
- Errors go to stderr.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.
- Always set `SAFE_ID` env var when running database commands.

## Database CLI (`db-query.js`)

Read-only access to wallet data:

```bash
# Recent failed receipts
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status tx_failed --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status validation_failed --limit 10
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status reverted --limit 10

# Recent orders (failed)
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-orders --status failed --limit 20

# Agent cycle logs
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-executor-log --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-sentinel-log --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-observer-log --limit 20

# Positions and portfolio
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-positions --status open
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-portfolio

# Paper mode variants
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-paper-receipts --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-paper-positions --status open

# Observer logging
SAFE_ID="$SAFE_ID" node scripts/db-query.js add-observer-log --json '{"errors_analyzed": 5, "issues_created": 1, "alerts_sent": 0, "summary": "Created issue for Safe rate limit", "status": "ok"}'

# Heartbeat tracking
SAFE_ID="$SAFE_ID" node scripts/db-query.js update-heartbeat --agent observer --check triage
```

## GitHub Integration

Uses the `gh` CLI (authenticated at container startup via `hosts.yml` written by entrypoint).

**Issue creation** goes through the **create-gh-issue** skill, which handles duplicate checking automatically. Do not use `gh issue create` directly.

```bash
# List open issues (for context or manual inspection)
gh issue list --repo "$OBSERVER_ISSUES_REPO" --state open --limit 50 --json number,title,body,url

# Comment on existing issue (used by create-gh-issue skill for recurrences)
gh issue comment <NUMBER> --repo "$OBSERVER_ISSUES_REPO" --body "Recurrence observed: ..."
```

**Security:** The `gh` CLI does NOT redact sensitive data. Always manually replace wallet addresses, keys, and hashes with `[REDACTED]` before creating issues or comments.

## Telegram Alerts

```bash
# System health alert
node scripts/send-alert.js --type system_health --agent observer --message "Model failure detected..."

# Available alert types for Observer:
#   system_health → TG_TOPIC_OBSERVER
```

## Signer Balance Monitoring

```bash
# Check all active chain signer balances
node scripts/check-signer-balances.js

# Check a specific chain
node scripts/check-signer-balances.js --chain base
```

Output includes `anyBelowThreshold` boolean. If `true`, send an alert:

```bash
node scripts/send-alert.js --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>"
```

## Log Files

```bash
# System log (script errors, cron job failures)
tail -200 /tmp/openclaw/system.log

# Daily archives
ls /tmp/openclaw/system.*.log

# OpenClaw gateway log (LLM calls, tool execution)
tail -100 /tmp/openclaw/openclaw.log
```

## Chain Discovery

```bash
# List active chains
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-chains
```

## Configuration

| Variable | Purpose |
|---|---|
| `SAFE_ID` | Fund identifier — determines which database |
| `PAPER_MODE` | `true` for paper trading data |
| `OBSERVER_ISSUES_REPO` | Private repo for issues (e.g., `owner/crypto-claw-issues`) |
