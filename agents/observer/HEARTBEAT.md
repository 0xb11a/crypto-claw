# HEARTBEAT.md — Observer Agent Schedule

## Schedule
Every 120 minutes, triggered by the observer-cycle cron job.

## Procedure

### 1. Read System Logs
```bash
tail -200 /tmp/openclaw/system.log
```
Scan for `[warn]`, `[error]`, and `[critical]` entries since your last run (see the Logging Severity Rubric in TOOLS.md for what each level means):

- **`[critical]`** — always actionable. Safety/integrity violation. Alert immediately.
- **`[error]`** — always actionable per-instance. Correlate with DB state (Step 2) and either file a GitHub issue or alert.
- **`[warn]`** — sample for **patterns only**. A single warn is expected (self-healing). But if you see the same warn shape (same source + same message pattern) fire more than 5 times in a 30-minute window, treat it as an `error` and open a GitHub issue — repeated "self-healing" is actually a masked bug.
- **`[info]`** — skip.

Note patterns: same error repeating, correlated failures across scripts, timing clusters.

If `system.log` does not exist or is empty, that means no scripts have logged since the last rotation or container restart — this is normal, not an error. Proceed to database queries.

### 2. Query Database for Failures
```bash
node scripts/db-query.js get-receipts --status tx_failed --limit 20
```
```bash
node scripts/db-query.js get-receipts --status validation_failed --limit 10
```
```bash
node scripts/db-query.js get-receipts --status reverted --limit 10
```
```bash
node scripts/db-query.js get-executor-log --limit 30
```
```bash
node scripts/db-query.js get-sentinel-log --limit 30
```
```bash
node scripts/db-query.js get-research-log --limit 30
```

### 2b. Check Signer Balances
```bash
node scripts/check-signer-balances.js
```
If any signer balance is below threshold, alert immediately via `send-alert.js` with type `signer_low_balance`. This prevents silent executor failures from drained gas accounts.

### 2c. Silent-Crash Scan
From the three `get-*-log` outputs above, filter rows where `status = "error"`. For each one, check the system log tail from Step 1: was a `send-alert.js` call logged near the same timestamp (±5 min)?

- **Log row with matching alert** → the agent reported itself; no action needed.
- **Log row with NO matching alert** → **silent crash.** The agent tried to record an error but the alerting path failed. File a GitHub issue via the create-gh-issue skill, citing the log row's `check_type`, `summary`, and `created_at`.

### 2d. Stale-Order Scan
```bash
node scripts/db-query.js get-orders --status approved --limit 20
```
```bash
node scripts/db-query.js get-orders --status queued_in_safe --limit 20
```
```bash
node scripts/db-query.js get-orders --status queued_in_squads --limit 20
```
```bash
node scripts/db-query.js get-orders --status pending --limit 20
```
For each row, compute `age_minutes = now - created_at`. Thresholds:
- `approved` → alert if > 15 min (Executor isn't picking it up)
- `queued_in_safe` / `queued_in_squads` → alert if > 30 min (multisig stalled)
- `pending` → alert if > 2 h (awaiting human approval too long)

Use `send-alert.js --type system_health --agent observer --message "..."` for each.

### 2e. Alert-Storm Scan
```bash
node scripts/db-query.js get-alerts
```
(Omit `--unprocessed` — storm detection needs ALL recent alerts, not just the un-triaged ones. Returns last 100 newest-first.) Group by `symbol + alert_type`. If the same combination appears more than 3 times within a 10-minute window, that is a storm. Either the underlying condition is genuinely cascading (real rug needing escalation) or the detector is stuck firing. Alert via `send-alert.js --type system_health` with the symbol, alert_type, and count.

### 2f. Dead-Agent + Cadence Scan
```bash
node scripts/db-query.js get-heartbeats
```
For each row, compare `seconds_since` against `expected_cadence_seconds`:
- `seconds_since > 2 × expected_cadence_seconds` → **dead agent**. Alert via `send-alert.js --type emergency_mode --agent observer --message "Agent <X>/<check> heartbeat stale: last run N min ago, cadence M min"`.
- Also check the `system/memory-backup` heartbeat — if stale > 30 min, the backup loop stopped and memory is no longer being persisted. Alert via `system_health`.

### 2g. Stuck-Token Loop Scan
```bash
node scripts/db-query.js get-receipts --status validation_failed --limit 30
```
Group by `symbol`. If the same symbol has more than 3 `validation_failed` receipts in the last 2 hours, the agent is stuck re-proposing a bad token and burning compute. File a GitHub issue — the fix is usually in the dedup cache or discovery filters.

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
node scripts/db-query.js add-observer-log --json '{"errors_analyzed": N, "issues_created": N, "alerts_sent": N, "summary": "...", "status": "ok"}'
```

Update your heartbeat:
```bash
node scripts/db-query.js update-heartbeat --agent observer --check triage
```

## Rules
- Maximum 3 GitHub issues per cycle
- Always use the create-gh-issue skill for issue creation — it handles duplicate checking
- If system.log is empty or has only `[info]` entries — log a clean run and exit
- In paper mode, monitoring works identically — paper failures matter too
