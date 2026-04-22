# TOOLS.md — Observer Agent Tools

## General Notes
- All scripts output JSON to stdout. Parse with `jq` or read directly.
- Errors go to stderr.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.
- `SAFE_ID` is exported by entrypoint.sh — db-query.js picks it up automatically, no need to prefix commands.

## Logging Severity Rubric (what you're scanning for in /tmp/openclaw/system.log)
`scripts/log.js` produces four levels. Your detection rules use all but `info`:
- `info` — routine step completed. Never actionable. **Skip.**
- `warn` — degraded but self-healing. **Sample for patterns:** if the same warn (same source+message shape) fires >5 times within 30 min, treat as an `error`-equivalent and open a GitHub issue.
- `error` — an operation did not complete. **Each instance is actionable** — correlate with DB state and file a GitHub issue unless a duplicate already exists.
- `critical` — safety/integrity violation. **Immediate Telegram alert** (`send-alert.js --type system_health` or `emergency_mode`).

If an agent's log table (research_log/sentinel_log/executor_log) has a `status:"error"` row and system.log has no matching `send-alert` call near that timestamp, that is a **silent crash** — file a GitHub issue. The agent tried to report but something upstream broke.

## Database CLI (`db-query.js`)

Read-only access to wallet data:

```bash
# Recent failed receipts
node scripts/db-query.js get-receipts --status tx_failed --limit 20
node scripts/db-query.js get-receipts --status validation_failed --limit 10
node scripts/db-query.js get-receipts --status reverted --limit 10

# Recent orders (failed)
node scripts/db-query.js get-orders --status failed --limit 20

# Agent cycle logs — status:"error" rows are silent-crash signals
node scripts/db-query.js get-executor-log --limit 30
node scripts/db-query.js get-sentinel-log --limit 30
node scripts/db-query.js get-research-log --limit 30
node scripts/db-query.js get-observer-log --limit 20

# Stale-order detection (compute age from created_at)
node scripts/db-query.js get-orders --status approved --limit 20
node scripts/db-query.js get-orders --status queued_in_safe --limit 20
node scripts/db-query.js get-orders --status queued_in_squads --limit 20
node scripts/db-query.js get-orders --status pending --limit 20

# Alert-storm detection (omit --unprocessed; returns last 100 newest-first)
node scripts/db-query.js get-alerts

# Dead-agent + cadence-drift detection
node scripts/db-query.js get-heartbeats
node scripts/db-query.js get-heartbeats --agent system

# Positions and portfolio
node scripts/db-query.js get-positions --status open
node scripts/db-query.js get-portfolio

# Paper mode variants
node scripts/db-query.js get-paper-receipts --limit 20
node scripts/db-query.js get-paper-positions --status open

# Observer logging
node scripts/db-query.js add-observer-log --json '{"errors_analyzed": 5, "issues_created": 1, "alerts_sent": 0, "summary": "Created issue for Safe rate limit", "status": "ok"}'

# Heartbeat tracking
node scripts/db-query.js update-heartbeat --agent observer --check triage
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
# Operational issues, stale orders, alert storms, config drift, model failure, memory-backup stale
node scripts/send-alert.js --type system_health --agent observer --message "Observer: stale approved order for <symbol> (<N> min old)"

# Dead-agent detection (heartbeat stale > 2× cadence)
node scripts/send-alert.js --type emergency_mode --agent observer --message "Agent <X>/<check> heartbeat stale: last run <N> min ago"

# Low signer gas balance
node scripts/send-alert.js --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>"

# Alert type → topic routing for Observer-initiated alerts:
#   system_health      → TG_TOPIC_OBSERVER
#   emergency_mode     → TG_TOPIC_ALERTS
#   signer_low_balance → TG_TOPIC_ALERTS
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
node scripts/db-query.js get-chains
```

## Configuration

| Variable | Purpose |
|---|---|
| `SAFE_ID` | Fund identifier — determines which database |
| `PAPER_MODE` | `true` for paper trading data |
| `OBSERVER_ISSUES_REPO` | Private repo for issues (e.g., `owner/crypto-claw-issues`) |
