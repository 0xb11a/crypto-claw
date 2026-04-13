# HEARTBEAT.md — Observer Agent Schedule

## Schedule
Every 60 minutes, triggered by the observer-cycle cron job.

## Procedure

### 1. Read System Logs
```bash
tail -200 /tmp/openclaw/system.log 2>/dev/null || echo "(system.log not found — no script has logged yet this cycle)"
```
Look for `[error]` and `[critical]` entries since your last run. Note patterns: same error repeating, correlated failures across scripts.

If `system.log` does not exist or is empty, that means no scripts have logged since the last rotation or container restart — this is normal, not an error. Proceed to database queries.

### 2. Query Database for Failures
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status tx_failed --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status validation_failed --limit 10
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status reverted --limit 10
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-executor-log --limit 10
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-sentinel-log --limit 10
```

### 2b. Check Signer Balances
```bash
node scripts/check-signer-balances.js
```
If any signer balance is below threshold, alert immediately via `send-alert.js` with type `signer_low_balance`. This prevents silent executor failures from drained gas accounts.

### 3. Analyze
- Correlate log errors with receipt/order failures
- Identify root cause (API rate limit? Contract issue? Logic bug?)
- Determine severity: does this need a code fix (GitHub issue) or just operational attention (alert)?

### 4. Check for Duplicates
```bash
node scripts/list-issues.js --label observer-auto --state open
```
If an existing issue matches the root cause, comment on it instead of creating a new one.

### 5. Take Action
- **Execution failures needing code fixes** → `node scripts/create-issue.js --title "..." --body "..." --labels "observer-auto,execution"`
- **Model failures / emergency activations** → `node scripts/send-alert.js --type system_health --agent observer --message "..."`
- **Duplicate / self-resolved / noise** → skip

### 6. Log Your Run
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js add-observer-log --json '{"errors_analyzed": N, "issues_created": N, "alerts_sent": N, "summary": "...", "status": "ok"}'
```

Update your heartbeat:
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js update-heartbeat --agent observer --check triage
```

## Rules
- Maximum 3 GitHub issues per cycle
- Always check for duplicates before creating issues
- If system.log is empty or has only `[info]` entries — log a clean run and exit
- In paper mode, monitoring works identically — paper failures matter too
