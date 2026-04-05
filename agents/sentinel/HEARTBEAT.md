# HEARTBEAT.md — Sentinel Agent

## Schedule
Sentinel heartbeat runs every 15 minutes. ALL checks run every heartbeat (not rotating).
Keep checks fast and mechanical.

## Every Heartbeat — Run ALL:

**Multi-chain:** Run position checks for ALL active chains. Positions have a `chain` field — iterate and check each chain's positions separately.

### 1. Price Check (CRITICAL)
```bash
# Check PAPER_MODE env var first!
#   Real mode:  node scripts/db-query.js get-positions --status open
#   Paper mode: node scripts/db-query.js get-paper-positions --status open
node scripts/check-positions.js
```
- Compare current prices against stop-loss and take-profit levels
- If stop-loss hit → write sell order: `node scripts/db-query.js add-order --json '{"action":"sell",...}'`, alert human
- If take-profit hit → write partial sell order, inform human
- If price dropped >20% since last check → write alert

### 2. Liquidity Check (CRITICAL)
```bash
node scripts/check-liquidity.js
```
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check liquidity_check
```
- Compare current liquidity against previous snapshot from DB
- If dropped >30% → CRITICAL: write sell-all order, alert human
- If dropped >15% → HIGH: write alert
- Save new snapshot: `node scripts/db-query.js add-liquidity-snapshot --address ... --chain ... --liquidity ...`

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

### 5. Log Results
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```
Use status: `"ok"` if nothing happened, `"notable"` if Tier 2 events occurred, `"alert"` if sell orders were written.
```bash
node scripts/db-query.js update-heartbeat --agent sentinel --check price_check
```

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
