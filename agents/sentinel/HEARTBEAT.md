# HEARTBEAT.md — Sentinel Agent

## Schedule
Sentinel heartbeat runs every 10 minutes. ALL checks run every heartbeat (not rotating).
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
node scripts/db-query.js update-heartbeat --agent sentinel --check liquidity_check
```
- Compare current liquidity against previous snapshot from DB
- If dropped >30% → CRITICAL: write sell-all order, alert human
- If dropped >15% → HIGH: write alert
- Save new snapshot: `node scripts/db-query.js add-liquidity-snapshot --address ... --chain ... --liquidity ...`

### 3. Wallet Check (if positions exist)
```bash
node scripts/check-wallets.js --positions
node scripts/db-query.js update-heartbeat --agent sentinel --check wallet_check
```
- Check dev/deployer wallets for sells
- Check large holders for dumps
- If dev selling → write sell-all order, alert human

### 4. Contract Check (max 2x per hour)
```bash
# Check if contract_check is due (cadence: 30 min, enforced server-side)
node scripts/db-query.js get-overdue-checks --agent sentinel
# Only run if contract_check appears in the overdue array
node scripts/check-contract.js --changes
node scripts/db-query.js update-heartbeat --agent sentinel --check contract_check
```
- Diffs GoPlus safety data against previous snapshot in `contract_snapshots`
- If became honeypot/pausable/blacklisted/proxy changed → CRITICAL: write sell-all order, alert human
- If owner changed, tax increased >5%, became mintable → HIGH: write alert
- First run per token stores baseline snapshot (no alerts)

### 5. Log Results
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
node scripts/db-query.js update-heartbeat --agent sentinel --check price_check
```

## Rules
- Run ALL checks every heartbeat, not just one
- Never skip a check to save tokens — your whole job is checking
- **Only use `node scripts/db-query.js` for database access. Never use `sqlite3` or any other database tool.**
- **Run `echo "PAPER_MODE=${PAPER_MODE:-false}"` at the start of every heartbeat.** Read the output. Use `get-paper-positions` if `true`, `get-positions` if `false`/unset. Reference this for every command in the cycle.
- If no open positions in DB → reply HEARTBEAT_OK immediately
- Keep total response under 500 tokens when nothing is wrong
