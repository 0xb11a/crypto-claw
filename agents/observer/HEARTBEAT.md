# HEARTBEAT.md — Observer Agent Schedule

## Schedule
Every 120 minutes, triggered by the observer-cycle cron job.

## Procedure

### 1. Read System Logs
```bash
tail -200 /tmp/openclaw/system.log
```
Look for `[error]` and `[critical]` entries since your last run. Note patterns: same error repeating, correlated failures across scripts.

If `system.log` does not exist or is empty, that means no scripts have logged since the last rotation or container restart — this is normal, not an error. Proceed to database queries.

### 2. Query Database for Failures
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status tx_failed --limit 20
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status validation_failed --limit 10
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status reverted --limit 10
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-executor-log --limit 20
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-sentinel-log --limit 20
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

### 4. Take Action
- **Execution failures needing code fixes** → use the **create-gh-issue** skill (handles duplicate checking automatically)
- **Model failures / emergency activations** → `node scripts/send-alert.js --type system_health --agent observer --message "..."`
- **Transient / self-resolved / noise** → skip

### 5. Log Your Run
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js add-observer-log --json '{"errors_analyzed": N, "issues_created": N, "alerts_sent": N, "summary": "...", "status": "ok"}'
```

Update your heartbeat:
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js update-heartbeat --agent observer --check triage
```

## Rules
- Maximum 3 GitHub issues per cycle
- Always use the create-gh-issue skill for issue creation — it handles duplicate checking
- If system.log is empty or has only `[info]` entries — log a clean run and exit
- In paper mode, monitoring works identically — paper failures matter too
