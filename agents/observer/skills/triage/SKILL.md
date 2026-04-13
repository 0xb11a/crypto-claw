# SKILL.md — Triage Skill

## Purpose
Analyze system logs and database error data, classify problems, and take appropriate action: create GitHub issues for code bugs, send Telegram alerts for operational issues, or skip noise.

## Trigger
Every heartbeat cycle (60 minutes). Activated by the observer-cycle cron job.

## Procedure

### Step 1: Gather Evidence

Read the system log for recent errors:
```bash
tail -200 /tmp/openclaw/system.log
```

Query the database for structured error data:
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-receipts --status tx_failed --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-orders --status failed --limit 20
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-executor-log --limit 10
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-sentinel-log --limit 10
```

### Step 1b: Check Signer Balances

```bash
node scripts/check-signer-balances.js
```

If `anyBelowThreshold` is `true`, send an alert for each chain that is below threshold:

```bash
node scripts/send-alert.js --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>. Refill needed to prevent silent execution failures."
```

This is always an operational issue (not a code bug). Do not create a GitHub issue for it.

### Step 2: Classify Each Problem

For each error or failure found, determine:

1. **Is it a code bug?** (e.g., missing error handling, wrong API endpoint, logic error)
   → GitHub issue

2. **Is it an operational issue?** (e.g., model provider down, config missing, API key expired)
   → Telegram alert

3. **Is it transient noise?** (e.g., single 429 that self-resolved, network blip)
   → Skip

4. **Is it a repeat of something already reported?**
   → Comment on existing issue or skip

### Step 3: Check for Duplicates

```bash
node scripts/list-issues.js --label observer-auto --state open
```

Compare each problem's root cause against existing open issues. If a match exists, either:
- Add a comment with new occurrence details: `node scripts/create-issue.js --update-issue <N> --body "..."`
- Skip if no new information

### Step 4: Create Issues (max 3 per cycle)

For each unique code bug, create a well-structured issue:

```bash
node scripts/create-issue.js \
  --title "fix: <concise description>" \
  --body "## Summary
<one sentence: what broke, what's the impact>

## Error Details
- **Source:** scripts/<name>.js
- **Error:** <error message from logs>
- **Chain:** <chain>
- **Frequency:** <count since first seen>

## System State
- Executor: <ok/emergency>
- Recent failures: <summary>

## Suggested Investigation
- File: scripts/<name>.js
- Area: <function name or error handling section>
- Pattern: <what likely needs to change>" \
  --labels "observer-auto,execution"
```

### Step 5: Send Alerts

For operational issues:
```bash
node scripts/send-alert.js --type system_health --agent observer --message "<concise description>"
```

### Step 6: Log the Cycle

```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js add-observer-log --json '{"errors_analyzed": <N>, "issues_created": <N>, "alerts_sent": <N>, "summary": "<one line>", "status": "ok"}'
SAFE_ID="$SAFE_ID" node scripts/db-query.js update-heartbeat --agent observer --check triage
```

## Examples

### Good Issue Title
`fix: Safe proposeTransaction fails with 429 after 3 retries on base chain`

### Bad Issue Title
`There was an error with transactions`

### Good Issue Body
Specific error message, which script, which chain, how often, where to look in the code.

### Bad Issue Body
Vague description without actionable details.

## Constraints
- Maximum 3 issues per cycle
- Always check duplicates first
- Never include sensitive data (addresses, keys, hashes)
- If no errors found, log a clean run and finish quickly
