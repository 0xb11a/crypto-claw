---
name: sentinel
description: Real-time monitoring of open positions for danger signals and exit triggers
triggers:
  - check positions
  - monitor portfolio
  - position health
  - any alerts
  - is my portfolio safe
  - check my tokens
---

# Sentinel Skill

## Purpose
Guardian of the portfolio. Watch every open position for danger. React faster than any human.

### Step 0: Load Configuration (MANDATORY — run at the start of every cycle)
```bash
echo "=== SENTINEL CONFIG ==="
echo "PAPER_MODE=${PAPER_MODE:-false}"
echo "ACTIVE_CHAINS=${ACTIVE_CHAINS}"
echo "======================"
```
Read the output. This determines your entire cycle:
- `PAPER_MODE=true` → use `get-paper-positions` for ALL position queries
- `PAPER_MODE=false` → use `get-positions`
- If `ACTIVE_CHAINS` is empty or unset, run `node scripts/db-query.js get-chains` to discover available chains
Getting this wrong means monitoring nothing. Reference this output for every command.

## When to Use
- During heartbeat checks (highest priority)
- When user asks about position safety
- After any market-wide event (crash, narrative shift)
- Continuously for critical positions

## Monitoring Checks

### Price Monitoring
```bash
node scripts/check-positions.js
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Price hit stop-loss | CRITICAL | Write sell_all order to DB |
| Moonshot TP1 hit (2x) | HIGH | Write sell 50% order, reason: `tp1_hit` |
| Moonshot TP2 hit (4x) | HIGH | Write sell 25% order, reason: `tp2_hit` |
| Moonshot TP3 hit (8x) | HIGH | Write sell 15% order, reason: `tp3_hit` |
| Conviction TP1 hit (1.5x) | HIGH | Write sell 35% order, reason: `tp1_hit` |
| Conviction TP2 hit (2.5x) | HIGH | Write sell 35% order, reason: `tp2_hit` |
| Conviction TP3 hit (4x) | HIGH | Write sell 20% order, reason: `tp3_hit` |
| Trailing stop triggered | CRITICAL | Write sell_all order, reason: `trailing_stop_hit` |
| Price dropped >20% in 1 check | HIGH | Alert Research, reassess |
| Price dropped >40% since entry | CRITICAL | Write sell order to DB |
| Price up >100% with no fundamentals change | MEDIUM | Alert Research, consider partial profit |

**After TP1 hit**: Move SL to breakeven (entry price) by updating the position.
**After TP2 hit**: Activate trailing stop (moonshot: 30%, conviction: 20%) below max price since entry.
**Trailing stop check**: On every price check, if trailing active and `currentPrice < maxPrice * (1 - trailPct)` → write sell_all order.

### Liquidity Monitoring
```bash
node scripts/check-liquidity.js
```

| Condition | Severity | Action |
|-----------|----------|--------|
| LP removed >30% in 1 hour | CRITICAL | Write sell_all order to DB |
| LP removed >15% in 24 hours | HIGH | Alert Research |
| LP increased significantly | INFO | Log as positive signal |
| LP provider count dropping | MEDIUM | Watch closely |

### Wallet Activity
```bash
node scripts/check-wallets.js --positions
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Dev wallet selling ANY amount | HIGH | Write sell order + alert Research |
| Whale selling >3% of supply | HIGH | Write sell-50% order + alert Research |
| Multiple early buyers exiting | MEDIUM | Alert Research |
| Smart money accumulating | INFO | Log as positive signal |

### Contract Monitoring
```bash
# Scan all open positions for contract changes (heartbeat usage)
node scripts/check-contract.js --changes

# Scan a specific token
node scripts/check-contract.js --changes --address <TOKEN_ADDRESS> --chain <CHAIN>
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Became honeypot | CRITICAL | Write sell_all order to DB + alert Research |
| Proxy status changed | CRITICAL | Write sell_all order to DB + alert Research |
| Became pausable | CRITICAL | Write sell_all order to DB + alert Research |
| Blacklist added | CRITICAL | Write sell_all order to DB + alert Research |
| Ownership transferred | CRITICAL | Write sell_all order to DB + alert Research |
| Buy/sell tax increased >5% | HIGH | Alert Research, log to DB |
| Became mintable | HIGH | Alert Research, log to DB |

## Alert Format

```
🚨 CRITICAL ALERT — [TOKEN SYMBOL]

Type: [rug_warning | stop_loss | liquidity_drain | dev_selling | contract_change]
Current Price: $X.XXXX
Entry Price: $X.XXXX
P&L: -XX%

What Happened:
[1-2 sentences]

Suggested Action: SELL ALL / SELL PARTIAL / HOLD / YOUR CALL

⏰ Time Sensitivity: Act within [minutes / hours]
```

**Tier 2 events** (price >20% drop without sell, liquidity 15-30% drop, tax >5%, mintable) are logged to `sentinel_log` with `status: "notable"` but do NOT trigger immediate Telegram alerts. They are included in the next periodic summary (every 3 hours if notable events exist, or mandatory daily proof-of-life).

**Summary format:**
```
📡 SENTINEL SUMMARY (last 3h)
Heartbeats: N | Positions: N
Notable: [list of events or "all clear"]
Sells written: N
Status: OPERATIONAL
```

## Writing Sell Orders to DB

When a CRITICAL or HIGH condition triggers a sell, write the order to the database so the Executor agent picks it up automatically:

```bash
node scripts/db-query.js add-order --json '{
  "id": "sell-<timestamp>",
  "action": "sell",
  "symbol": "TOKEN",
  "address": "<token_address>",
  "chain": "<chain>",
  "amount": "all",
  "reason": "stop_loss_hit",
  "urgency": "immediate"
}'
```

For partial sells (e.g., take-profit levels):
```bash
node scripts/db-query.js add-order --json '{
  "id": "sell-<timestamp>",
  "action": "sell",
  "symbol": "TOKEN",
  "address": "<token_address>",
  "chain": "<chain>",
  "amount": "50%",
  "reason": "tp1_hit",
  "urgency": "normal"
}'
```

After writing a sell order, notify the human:
```bash
node scripts/send-alert.js --type sell_triggered --agent sentinel --message "SELL $TOKEN on <chain> — <amount> — reason: <reason>"
```

The Executor agent polls for approved orders every heartbeat and executes them through the Safe wallet.

## Rules
- CRITICAL alerts go to human IMMEDIATELY — never wait for next heartbeat
- For CRITICAL events, write sell orders to DB right away — the Executor handles execution
- Log ALL alerts to daily memory, even false alarms (pattern learning)
- Sentinel does not execute trades — it writes sell orders and the Executor processes them
- Keep monitoring runs cheap — use scripts for data, LLM only for decision-making
- Do NOT send `heartbeat_summary` or any Telegram alert after a quiet heartbeat where no sells were triggered and no notable events occurred
- Quiet cycle = no sells, no notable events → zero Telegram messages

## Paper Mode

When `PAPER_MODE=true`, the entire workflow above applies but position queries use paper commands:

| Action | Real Mode | Paper Mode |
|--------|-----------|------------|
| Get positions | `get-positions --status open` | `get-paper-positions --status open` |
| Get specific position | `get-positions --symbol TOKEN` | `get-paper-positions --symbol TOKEN` |

Everything else is identical:
- Monitoring scripts (check-positions.js, check-liquidity.js, check-wallets.js) run the same
- Sell orders are written to `orders` table (Executor handles paper routing)
- Alerts are written to `sentinel_alerts` table (unchanged)
