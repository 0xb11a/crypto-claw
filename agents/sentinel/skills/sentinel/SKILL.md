---
name: sentinel
description: Real-time position monitoring with auto-sell execution
triggers:
  - check positions
  - position health
  - any alerts
  - is my portfolio safe
---

# Sentinel Skill

## Purpose
Compare numbers. Detect anomalies. Execute sells. That's it.

## Process (Every Heartbeat)

### Step 1: Load State
```bash
# Read current positions
cat memory/portfolio-state.json

# Read previous liquidity snapshots
cat memory/liquidity-state.json
```

If no positions exist → HEARTBEAT_OK, done.

### Step 2: Check Prices
```bash
node scripts/check-positions.js
```

For each position, compare:
- `currentPrice` vs `stopLoss` → if hit, SELL ALL
- `currentPrice` vs each `takeProfitLevel.price` → if hit and not yet triggered, SELL partial
- `currentPrice` vs `entryPrice` → if down >20% since last check, ALERT

### Step 3: Check Liquidity
```bash
node scripts/check-liquidity.js
```

For each position, compare:
- Current liquidity vs previous → if dropped >30%, SELL ALL (rug warning)
- Current liquidity vs previous → if dropped >15%, ALERT

### Step 4: Write Results

For sells, write to `memory/sell-orders.json`:
```json
{
  "id": "unique-id",
  "timestamp": "ISO-8601",
  "action": "sell",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "ethereum",
  "amount": "all",
  "reason": "stop_loss",
  "urgency": "immediate",
  "executed": false
}
```

For alerts, write to `memory/sentinel-alerts.json`.
Always append to `memory/sentinel-log.json`.

### Step 5: Notify
- CRITICAL (rug, stop-loss): message human IMMEDIATELY
- HIGH (whale dump, liquidity decline): message human
- MEDIUM (minor fluctuation): log only, don't message
