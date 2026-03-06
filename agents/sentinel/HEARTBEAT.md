# HEARTBEAT.md — Sentinel Agent

## Schedule
Sentinel heartbeat runs every 5 minutes. ALL checks run every heartbeat (not rotating).
This agent uses the cheapest model available. Keep checks fast and mechanical.

## Every Heartbeat — Run ALL:

### 1. Price Check (CRITICAL)
```bash
node scripts/db-query.js get-positions --status open
node scripts/check-positions.js
```
- Compare current prices against stop-loss and take-profit levels
- If stop-loss hit → write sell order: `node scripts/db-query.js add-sell-order --json '...'`, alert human
- If take-profit hit → write partial sell order, inform human
- If price dropped >20% since last check → write alert

### 2. Liquidity Check (CRITICAL)
```bash
node scripts/check-liquidity.js
```
- Compare current liquidity against previous snapshot from DB
- If dropped >30% → CRITICAL: write sell-all order, alert human
- If dropped >15% → HIGH: write alert
- Save new snapshot: `node scripts/db-query.js add-liquidity-snapshot --address ... --chain ... --liquidity ...`

### 3. Wallet Check (if positions exist)
```bash
node scripts/check-wallets.js --positions
```
- Check dev/deployer wallets for sells
- Check large holders for dumps
- If dev selling → write sell-all order, alert human

### 4. Log Results
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
node scripts/db-query.js update-heartbeat --agent sentinel --check price_check
```

## Rules
- Run ALL checks every heartbeat, not just one
- Never skip a check to save tokens — your whole job is checking
- If no open positions in DB → reply HEARTBEAT_OK immediately
- Keep total response under 500 tokens when nothing is wrong
