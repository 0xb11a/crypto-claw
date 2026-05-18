---
name: triage
description: Analyze system logs and DB error data, classify problems, and take action — GitHub issue for code bugs, Telegram alert for operational issues, skip noise
triggers:
  - observer triage
  - run triage
  - triage errors
  - check system health
---

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
cclaw receipts list --status tx_failed --limit 20
```
```bash
cclaw receipts list --status validation_failed --limit 30
```
```bash
cclaw receipts list --status reverted --limit 10
```
```bash
cclaw orders list --status failed --limit 20
```
```bash
cclaw logs executor list --limit 30
```
```bash
cclaw logs sentinel list --limit 30
```
```bash
cclaw logs research list --limit 30
```
```bash
cclaw alerts list
```
```bash
cclaw heartbeat list
```
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
cclaw system meta get --key last_activity_wallets_bg_at
```
```bash
cclaw system meta get --key last_score_wallets_bg_at
```
```bash
cclaw wallets signals --since 2h --limit 1
```

### Step 2: Check Signer Balances

[cclaw expansion pending — `cclaw executor check-signer-balances` not yet implemented; `scripts/check-signer-balances.js` was deleted in P5. Check signer balance status from executor_log errors and system.log instead.]

```bash
cclaw logs executor list --limit 5
```
(look for `no_signer_key` errors or `signer_low_balance` entries)

If any `no_signer_key` or low-balance error appears in executor_log or system.log, send an alert for each affected chain:

```bash
cclaw alerts send --type signer_low_balance --agent observer --message "Signer on <chain> has <balance> <symbol> — below threshold <threshold>. Refill needed to prevent silent execution failures."
```

This is always an operational issue (not a code bug). Do not create a GitHub issue for it.

### Step 3: Classify Each Problem

For each error or failure found, run through the full signal catalogue below and decide what to do. The goal is to catch every category of suspicious behavior — not just tx failures.

**A. Code bugs (→ GitHub issue via create-gh-issue skill)**
1. Execution failures: `tx_failed`, `validation_failed`, `reverted` receipts with a reproducible cause (not just transient 429).
2. Silent crashes: an agent's log table has `status: "error"` but no matching `POST /v1/alerts/send` audit entry near that timestamp. The `--since` flag requires an ISO timestamp — compute SINCE manually (5 min before the log row's `created_at`) and run `cclaw system audit --path /v1/alerts/send --since "<ISO timestamp in YYYY-MM-DDTHH:MM:SSZ format>"`. The agent tried to record a failure but the alerting path itself broke.
3. Orphan approved trades: Research `research_log` row shows `trades_proposed: N` but fewer than N matching `orders` rows created in the following 10 min — the handoff dropped trades.
4. Stuck-token loops: the same token has >3 `validation_failed` receipts in the last 2 h — discovery/dedup is stuck re-proposing a bad token.
5. Warn pattern: the same warn shape (same source + same message pattern) fired >5 times in a 30-min window — "self-healing" is masking a real bug.
6. Repeated transient errors on the same script across multiple cycles.

**B. Operational issues (→ Telegram alert via `cclaw alerts send`)**
1. Stale orders: `approved` > 15 min, `queued_in_safe`/`queued_in_squads` > 30 min, `pending` > 2 h — use `system_health`.
2. Dead agents: `cclaw heartbeat list` shows `seconds_since > 2 × expected_cadence_seconds` AND `idle_ok` is `false` — use `emergency_mode`. Skip rows where `idle_ok: true` (executor/sentinel are demand-driven and idle on purpose when there are no approved orders / open positions).
3. Memory-backup loop stopped: `system/memory-backup` heartbeat stale > 30 min — use `system_health`.
4. Alert storms: `cclaw alerts list` has >3 identical `symbol + alert_type` entries in 10 min — use `system_health`.
5. Background-loop stale: `last_activity_wallets_bg_at` missing or older than 90 min (3× 30-min cadence) → signal feed stalled; `last_score_wallets_bg_at` missing or older than 30 min (3× 10-min cadence) → proposed-wallet queue not draining. Use `system_health`.
6. Silent signal regression: `cclaw wallets signals --since 2h --limit 1` returns `[]` AND `last_activity_wallets_bg_at` is fresh (loop running but producing zero swaps — possible upstream API regression). Skip if Step B.5 already fired on `last_activity_wallets_bg_at`. Use `system_health`.
7. Model failure / emergency mode activation.
8. Configuration drift (env var missing, wrong model, OpenClaw version regression).
9. Signer balance below threshold (Step 2 already handles this).

**C. Transient noise (→ Skip)**
- Single 429 that self-resolved.
- Single `[warn]` entry without a pattern.
- Single network blip with successful retry.

**D. Redaction failure** (→ Stop, do NOT file — log + alert)
- If any log row or receipt you're about to include in an issue still contains an unredacted address/key/hash after the create-gh-issue skill's redaction audit, STOP. Write `observer_log` with `status: "error"` and `cclaw alerts send --type system_health --agent observer --message "Redaction audit blocked GitHub issue; see observer_log"` describing the redaction failure. Fixing the leak takes priority over reporting the original bug.

### Step 4: Create Issues (max 3 per cycle)

For each code bug identified in Step 3, use the **create-gh-issue** skill. That skill handles duplicate checking automatically — it fetches all open issues and compares before creating.

Provide the skill with:
- **Title** — prefixed with `fix: `, concise description of the problem
- **Body** — structured with Summary, Error Details, System State, Suggested Investigation
- **Source script** — which `.js` file produced the error
- **Chain** — which chain is affected (if applicable)

**Security:** Never include wallet addresses, private keys, API keys, or transaction hashes. Replace with `[REDACTED]`.

### Step 5: Send Alerts

For operational issues:
```bash
cclaw alerts send --type system_health --agent observer --message "<concise description>"
```

### Step 6: Log the Cycle

```bash
cclaw logs observer append --json '{"errors_analyzed": <N>, "issues_created": <N>, "alerts_sent": <N>, "summary": "<one line>", "status": "ok"}'
```

```bash
cclaw heartbeat ping --agent observer --check triage
```

## Promotion
If a failure mode (e.g., a recurring API error, retry-exhaustion signature, or systemic timeout pattern) recurs 3+ times across cycles, promote via `node scripts/promote-pattern.js`. **Never edit `MEMORY.md` directly** — manual edits are rejected by pre-commit (PR 3.1). The script validates the pattern's provenance against trusted DB tables (Observer's source is `observer_log:<id>`).

```bash
node scripts/promote-pattern.js --name "<Failure Mode Name>" --description "<what fails and why it matters>" --signal "<log/alert pattern that triggers it>" --action "<what the operator/agent should do>" --seen 3 --attestation-source observer --derived-from "observer_log:<id>,observer_log:<id>,observer_log:<id>"
```

`--derived-from` IDs must exist in trusted DB tables — see Observer AGENTS.md § Core Principle #6. The script REFUSES to write if any ID can't be resolved, so invented patterns (hallucination, prompt injection from log/issue text) cannot land. Observer writes to the same `MEMORY.md` as Research — the workspace is symlinked across all four agents, so a successful promotion is visible everywhere.

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
