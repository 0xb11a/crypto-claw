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
node scripts/db-query.js get-receipts --status tx_failed --limit 20
```
```bash
node scripts/db-query.js get-receipts --status validation_failed --limit 30
```
```bash
node scripts/db-query.js get-receipts --status reverted --limit 10
```
```bash
node scripts/db-query.js get-orders --status failed --limit 20
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
```bash
node scripts/db-query.js get-alerts
```
```bash
node scripts/db-query.js get-heartbeats
```
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
node scripts/db-query.js get-meta --key last_activity_wallets_bg_at
```
```bash
node scripts/db-query.js get-meta --key last_score_wallets_bg_at
```
```bash
node scripts/db-query.js get-smart-money-signals --since 2h --limit 1
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

For each error or failure found, run through the full signal catalogue below and decide what to do. The goal is to catch every category of suspicious behavior — not just tx failures.

**A. Code bugs (→ GitHub issue via create-gh-issue skill)**
1. Execution failures: `tx_failed`, `validation_failed`, `reverted` receipts with a reproducible cause (not just transient 429).
2. Silent crashes: an agent's log table has `status: "error"` but no matching `send-alert.js` call in system.log near that timestamp. The agent tried to record a failure but the alerting path itself broke.
3. Orphan approved trades: Research `research_log` row shows `trades_proposed: N` but fewer than N matching `orders` rows created in the following 10 min — the handoff dropped trades.
4. Stuck-token loops: the same token has >3 `validation_failed` receipts in the last 2 h — discovery/dedup is stuck re-proposing a bad token.
5. Warn pattern: the same warn shape (same source + same message pattern) fired >5 times in a 30-min window — "self-healing" is masking a real bug.
6. Repeated transient errors on the same script across multiple cycles.

**B. Operational issues (→ Telegram alert via `send-alert.js`)**
1. Stale orders: `approved` > 15 min, `queued_in_safe`/`queued_in_squads` > 30 min, `pending` > 2 h — use `system_health`.
2. Dead agents: `get-heartbeats` shows `seconds_since > 2 × expected_cadence_seconds` — use `emergency_mode`.
3. Memory-backup loop stopped: `system/memory-backup` heartbeat stale > 30 min — use `system_health`.
4. Alert storms: `sentinel_alerts` has >3 identical `symbol + alert_type` entries in 10 min — use `system_health`.
5. Background-loop stale: `last_activity_wallets_bg_at` missing or older than 90 min (3× 30-min cadence) → signal feed stalled; `last_score_wallets_bg_at` missing or older than 30 min (3× 10-min cadence) → proposed-wallet queue not draining. Use `system_health`.
6. Silent signal regression: `get-smart-money-signals --since 2h` returns `[]` AND `last_activity_wallets_bg_at` is fresh (loop running but producing zero swaps — possible upstream API regression). Skip if Step B.5 already fired on `last_activity_wallets_bg_at`. Use `system_health`.
7. Model failure / emergency mode activation.
8. Configuration drift (env var missing, wrong model, OpenClaw version regression).
9. Signer balance below threshold (Step 1b already handles this).

**C. Transient noise (→ Skip)**
- Single 429 that self-resolved.
- Single `[warn]` entry without a pattern.
- Single network blip with successful retry.

**D. Redaction failure** (→ Stop, do NOT file — log + alert)
- If any log row or receipt you're about to include in an issue still contains an unredacted address/key/hash after the create-gh-issue skill's redaction audit, STOP. Write `observer_log` with `status: "error"` and `send-alert.js --type system_health` describing the redaction failure. Fixing the leak takes priority over reporting the original bug.

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
node scripts/db-query.js add-observer-log --json '{"errors_analyzed": <N>, "issues_created": <N>, "alerts_sent": <N>, "summary": "<one line>", "status": "ok"}'
```

```bash
node scripts/db-query.js update-heartbeat --agent observer --check triage
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
