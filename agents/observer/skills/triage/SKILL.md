# SKILL.md — Triage Skill

## Purpose
Analyze system logs and database error data, classify problems, and take appropriate action: create GitHub issues for code bugs, send Telegram alerts for operational issues, or skip noise.

## Trigger
Every heartbeat cycle (120 minutes). Activated by the observer-cycle cron job.

## Procedure

### Step 1: Gather Evidence

Read the system log for recent errors:
```bash
tail -200 /tmp/openclaw/system.log
```
If `system.log` does not exist or the command fails, that is normal after rotation or container restart — proceed to database queries.

Query the database for structured error data:
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
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-orders --status failed --limit 20
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-executor-log --limit 20
```
```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js get-sentinel-log --limit 20
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

### Step 3: Create Issues (max 3 per cycle)

For each code bug identified in Step 2, use the **create-gh-issue** skill. That skill handles duplicate checking automatically — it fetches all open issues and compares before creating.

Provide the skill with:
- **Title** — prefixed with `fix: `, concise description of the problem
- **Body** — structured with Summary, Error Details, System State, Suggested Investigation
- **Source script** — which `.js` file produced the error
- **Chain** — which chain is affected (if applicable)

**Security:** Never include wallet addresses, private keys, API keys, or transaction hashes. Replace with `[REDACTED]`.

### Step 5: Send Alerts

For operational issues:
```bash
node scripts/send-alert.js --type system_health --agent observer --message "<concise description>"
```

### Step 6: Log the Cycle

```bash
SAFE_ID="$SAFE_ID" node scripts/db-query.js add-observer-log --json '{"errors_analyzed": <N>, "issues_created": <N>, "alerts_sent": <N>, "summary": "<one line>", "status": "ok"}'
```

```bash
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
- Always use the create-gh-issue skill for issue creation — it handles duplicate checking
- Never include sensitive data (addresses, keys, hashes)
- If no errors found, log a clean run and finish quickly
