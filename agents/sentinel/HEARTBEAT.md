# HEARTBEAT.md — Sentinel Agent

## Schedule
Sentinel heartbeat runs every 15 minutes. ALL checks run every heartbeat (not rotating).
Keep checks fast and mechanical.

> **Note on `check_type` naming.** Two different tables use a `check_type` column, and they follow different conventions:
> - `add-sentinel-log --json '{"check_type":"price",...}'` writes to `sentinel_log.check_type`, which is a free-form descriptor (bare form: `price`, `liquidity`, `wallet`, `contract`, `all`, `emergency`). Used by Observer when citing log rows.
> - `update-heartbeat --check price_check` writes to `heartbeat_state.check_type`, which MUST match a `HEARTBEAT_CADENCES.sentinel` key (`_check`-suffixed form). Unknown keys are silently ignored by `get-overdue-checks`.

## Every Heartbeat — Run ALL:

**Multi-chain:** Run position checks for ALL active chains. Positions have a `chain` field — iterate and check each chain's positions separately.

### 1. Price Check (CRITICAL)
```bash
# Check PAPER_MODE env var first!
#   Real mode:  node scripts/db-query.js get-positions --status open
#   Paper mode: node scripts/db-query.js get-paper-positions --status open
node scripts/check-positions.js
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check price_check
```
- Compare current prices against stop-loss and take-profit levels
- If stop-loss hit → write sell order: `node scripts/db-query.js add-order --json '{"action":"sell",...}'`, alert human
- If take-profit hit → write partial sell order, inform human
- If price dropped >20% since last check → write alert
- **If `check-positions.js` exits non-zero or returns no JSON:** log `add-sentinel-log --json '{"check_type":"price","status":"error","summary":"<reason>"}'` AND `send-alert.js --type rug_warning --agent sentinel --message "price check failed — positions unmonitored: <reason>"`. Do not proceed to evaluate stops against stale data. (See AGENTS.md § Error Self-Reporting.)
- **If `add-order` for a sell fails:** `send-alert.js --type sell_triggered --agent sentinel --message "SELL ORDER WRITE FAILED for <symbol>: <reason>"`. The worst failure mode Sentinel has.

### 2. Liquidity Check (CRITICAL)
```bash
node scripts/check-liquidity.js
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check liquidity_check
```
- Compares current liquidity against the **oldest snapshot inside each window** (1h and 24h) — catches slow bleeds the per-check delta misses
- If dropped >30% in 1h → CRITICAL: write sell-all order, alert human
- If dropped >15% in 24h → HIGH: write alert
- If no snapshot exists inside a window (fresh position), that band is skipped for this cycle
- Save new snapshot: `node scripts/db-query.js add-liquidity-snapshot --address ... --chain ... --liquidity ...`
- **If `check-liquidity.js` exits non-zero or returns no JSON:** log `add-sentinel-log --json '{"check_type":"liquidity","status":"error","summary":"<reason>"}'` AND `send-alert.js --type rug_warning --agent sentinel --message "liquidity check failed — rug detection blind: <reason>"`. A failed liquidity check means you cannot detect a rug this cycle.

### 3. Wallet Check (if positions exist)
```bash
node scripts/check-wallets.js --positions
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check wallet_check
```
- Check dev/deployer wallets for sells
- Check large holders for dumps
- If dev selling → write sell-all order, alert human
- **If `check-wallets.js` exits non-zero or returns no JSON:** log `add-sentinel-log --json '{"check_type":"wallet","status":"error","summary":"<reason>"}'` AND `send-alert.js --type rug_warning --agent sentinel --message "wallet check failed — dev/whale activity unknown this cycle: <reason>"`.

### 3b. Smart-Money Exit Signals (if positions exist)
Read SELL signals on tokens we currently hold, written by the activity-wallets-bg loop:
```bash
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check smart_money_exits
```

| Condition | Severity | Action |
|-----------|----------|--------|
| ≥ 2 distinct smart_money wallets sold a held token in last 30 min | HIGH | Alert via `send-alert.js --type sell_triggered --agent sentinel --message "Smart money exiting $TOKEN — N wallets sold in 30m, consider tightening stops"`. Do NOT auto-write a sell order — informational only. |
| 1 smart_money sell on a held token | NOTABLE | Log to `sentinel_log` with `status:"notable"`. No Telegram alert. |
| 0 sells | OK | Silent. |

Why no auto-sell: smart-money "sells" can be wallet-to-wallet rotations, bridges, or misclassified swaps. The dev-wallet check (Step 3) writes sell orders directly because dev selling is unambiguous. Smart-money exit clusters are a heads-up for Research / the operator to decide.

### 4. Contract Check (max 2x per hour)
```bash
node scripts/db-query.js get-overdue-checks --agent sentinel
```
Only run the following if `contract_check` appears in the overdue array:
```bash
node scripts/check-contract.js --changes
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check contract_check
```
- Diffs GoPlus safety data against previous snapshot in `contract_snapshots`
- If became honeypot/pausable/blacklisted/proxy changed → CRITICAL: write sell-all order, alert human
- If owner changed, tax increased >5%, became mintable → HIGH: write alert
- First run per token stores baseline snapshot (no alerts)
- **If `check-contract.js` exits non-zero or returns no JSON:** log `add-sentinel-log --json '{"check_type":"contract","status":"error","summary":"<reason>"}'` AND `send-alert.js --type rug_warning --agent sentinel --message "contract check failed — can't detect proxy/pausable/blacklist changes: <reason>"`.

### 5. Log Results
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```
Use status: `"ok"` if nothing happened, `"notable"` if Tier 2 events occurred, `"alert"` if sell orders were written.

### 6. Summary Decision (ONLY after logging)
Decide whether to send a periodic summary. Do NOT send alerts for quiet heartbeats.

1. **Did you write sell orders this cycle?** → Immediate `sell_triggered` alert already sent in the skill. Done.
2. **Were there notable (non-sell) events?** (price >20% drop, liquidity 15-30%, tax >5%, mintable) → Already logged with `status: "notable"` above. Do NOT send a Telegram alert now.
3. **Is a periodic summary due?** Check:
   ```bash
   # Check recent logs — covers ~3h of 15-min heartbeats
   # Look for any entries with status "notable" AND check timestamps to determine if >3h since last summary
   node scripts/db-query.js get-sentinel-log --limit 12
   ```
   - If notable logs exist in last 3h AND you haven't sent a summary in this window → send `heartbeat_summary` with event details
   - If no summary sent in >24h → send mandatory daily proof-of-life summary
   - Otherwise → **stay completely silent**

Summary format:
```bash
node scripts/send-alert.js --type heartbeat_summary --agent sentinel --message "SENTINEL SUMMARY (last 3h)\nHeartbeats: N | Positions: N\nNotable: [events or all clear]\nSells written: N\nStatus: OPERATIONAL"
```

## Rules
- Run ALL checks every heartbeat, not just one
- Never skip a check to save tokens — your whole job is checking
- **Only use `node scripts/db-query.js` for database access. Never use `sqlite3` or any other database tool.**
- **Run `echo "PAPER_MODE=${PAPER_MODE:-false}"` at the start of every heartbeat.** Read the output. Use `get-paper-positions` if `true`, `get-positions` if `false`/unset. Reference this for every command in the cycle.
- If no open positions in DB → reply HEARTBEAT_OK immediately
- Keep total response under 500 tokens when nothing is wrong
- Do NOT call `send-alert.js` when all checks pass with no events — quiet runs produce zero Telegram messages
- Only send Telegram alerts for: sell orders (immediate), periodic summaries (3h cadence if notable events), or 24h proof-of-life
