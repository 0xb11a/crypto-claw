# TOOLS.md — Observer Agent Tools

## General Notes
- All scripts output JSON to stdout. Parse with `jq` or read directly.
- Errors go to stderr.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.
- `SAFE_ID` is exported by entrypoint.sh — both `cclaw` and legacy `db-query.js` pick it up automatically.

## Logging Severity Rubric (what you're scanning for in /tmp/openclaw/system.log)
`scripts/log.js` produces four levels. Your detection rules use all but `info`:
- `info` — routine step completed. Never actionable. **Skip.**
- `warn` — degraded but self-healing. **Sample for patterns:** if the same warn (same source+message shape) fires >5 times within 30 min, treat as an `error`-equivalent and open a GitHub issue.
- `error` — an operation did not complete. **Each instance is actionable** — correlate with DB state and file a GitHub issue unless a duplicate already exists.
- `critical` — safety/integrity violation. **Immediate Telegram alert** (`node scripts/send-alert.js --type system_health` or `emergency_mode`).

If an agent's log table (research_log/sentinel_log/executor_log) has a `status:"error"` row and system.log has no matching `send-alert` call near that timestamp, that is a **silent crash** — file a GitHub issue. The agent tried to report but something upstream broke.

## API CLI (`cclaw`) and legacy CLI (`db-query.js`)

Prefer `cclaw` where listed; use legacy `node scripts/db-query.js` for hold-backs (commands without a `cclaw` equivalent yet, pending P5b/P6 expansion). Commands without a `cclaw` equivalent are annotated `(legacy hold-back)`.

### Recent failed receipts
```bash
cclaw receipts list --status tx_failed --limit 20
```
```bash
cclaw receipts list --status validation_failed --limit 10
```
```bash
cclaw receipts list --status reverted --limit 10
```

### Recent failed orders
```bash
cclaw orders list --status failed --limit 20
```

### Agent cycle logs (legacy hold-back — `cclaw agent-logs` pending P5)
Agent log tables have `status:"error"` rows as silent-crash signals.
```bash
node scripts/db-query.js get-executor-log --limit 30
```
```bash
node scripts/db-query.js get-sentinel-log --limit 30
```
```bash
node scripts/db-query.js get-research-log --limit 30
```
```bash
node scripts/db-query.js get-observer-log --limit 20
```

### Stale-order detection (compute age from created_at)
```bash
cclaw orders list --status approved --limit 20
```
```bash
cclaw orders list --status queued_in_safe --limit 20
```
```bash
cclaw orders list --status queued_in_squads --limit 20
```
```bash
cclaw orders list --status pending --limit 20
```

### Alert-storm detection
```bash
cclaw alerts list
```
Returns last 100 newest-first. (Omit `--unprocessed` — storm detection needs ALL recent alerts.)

### Dead-agent + cadence-drift detection
```bash
cclaw heartbeat list
```
Each row carries `idle_ok=true` when staleness is expected: executor/process_orders with zero `approved` orders, or sentinel/* with zero open positions. Skip the emergency_mode alert for those rows — the wrapper loop intentionally did not invoke the agent because there was no work.
```bash
cclaw heartbeat list --agent system
```

### Background-loop liveness (legacy hold-back)
Written by WalletScoringProcessor / WalletActivityProcessor (NestJS workers) at the end of every cycle — staler than 3× cadence means the job has stalled.
```bash
node scripts/db-query.js get-meta --key last_activity_wallets_bg_at
```
```bash
node scripts/db-query.js get-meta --key last_score_wallets_bg_at
```

### Smart-money signal volume (silent-API-regression scan, legacy hold-back)
Empty result over a 2 h window while `last_activity_wallets_bg_at` is fresh means the loop is running but producing nothing — likely upstream API returning 200 OK with empty results, or schema drift.
```bash
node scripts/db-query.js get-smart-money-signals --since 2h --limit 1
```

### Positions and portfolio
```bash
cclaw positions list --status open
```
```bash
cclaw receipts list --limit 20
```

### Observer logging (legacy hold-back)
```bash
node scripts/db-query.js add-observer-log --json '{"errors_analyzed": 5, "issues_created": 1, "alerts_sent": 0, "summary": "Created issue for Safe rate limit", "status": "ok"}'
```

### Heartbeat tracking
```bash
cclaw heartbeat ping --agent observer --check triage
```

### Chain discovery (legacy hold-back)
```bash
node scripts/db-query.js get-chains
```

## GitHub Integration

Uses the `gh` CLI (authenticated at container startup via `hosts.yml` written by entrypoint).

**Issue creation** goes through the **create-gh-issue** skill, which handles duplicate checking automatically. Do not use `gh issue create` directly.

```bash
gh issue list --repo "$OBSERVER_ISSUES_REPO" --state open --limit 50 --json number,title,body,url
```
```bash
gh issue comment <NUMBER> --repo "$OBSERVER_ISSUES_REPO" --body "Recurrence observed: ..."
```

**Security:** The `gh` CLI does NOT redact sensitive data. Always manually replace wallet addresses, keys, and hashes with `[REDACTED]` before creating issues or comments.

## Telegram Alerts (legacy hold-back — `cclaw notifications` pending P5c)

```bash
node scripts/send-alert.js --type system_health --agent observer --message "Observer: stale approved order for <symbol> (<N> min old)"
```
```bash
node scripts/send-alert.js --type emergency_mode --agent observer --message "Agent <X>/<check> heartbeat stale: last run <N> min ago"
```
```bash
node scripts/send-alert.js --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>"
```

Alert type → topic routing for Observer-initiated alerts:
- `system_health` → TG_TOPIC_OBSERVER
- `emergency_mode` → TG_TOPIC_ALERTS
- `signer_low_balance` → TG_TOPIC_ALERTS

## Signer Balance Monitoring

[cclaw expansion pending P5b — `scripts/check-signer-balances.js` was deleted in P5. Detect signer balance issues via executor_log errors instead.]

```bash
node scripts/db-query.js get-executor-log --limit 5
```
(legacy hold-back — look for `no_signer_key` or similar errors indicating drained gas accounts)

If any low-balance indicator appears, send an alert:

```bash
node scripts/send-alert.js --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>"
```

## Log Files

```bash
tail -200 /tmp/openclaw/system.log
```
```bash
ls /tmp/openclaw/system.*.log
```
```bash
tail -100 /tmp/openclaw/openclaw.log
```

## Configuration

| Variable | Purpose |
|---|---|
| `SAFE_ID` | Fund identifier — determines which database |
| `OBSERVER_ISSUES_REPO` | Private repo for issues (e.g., `owner/crypto-claw-issues`) |
