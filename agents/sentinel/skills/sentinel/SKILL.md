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

**IMPORTANT: Check `PAPER_MODE` env var at the start of every cycle.** If `true`, use `get-paper-positions` for ALL position queries. If `false` or unset, use `get-positions`. Getting this wrong means monitoring nothing.

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
| Price hit TP level | HIGH | Write partial sell order to DB |
| Price dropped >20% in 1 check | HIGH | Alert Research, reassess |
| Price dropped >40% since entry | CRITICAL | Write sell order to DB |
| Price up >100% with no fundamentals change | MEDIUM | Alert Research, consider partial profit |

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
| Whale selling >3% of supply | HIGH | Alert Research, assess impact |
| Multiple early buyers exiting | MEDIUM | Alert Research |
| Smart money accumulating | INFO | Log as positive signal |

### Contract Monitoring
```bash
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN> --changes
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Proxy implementation changed | CRITICAL | Write sell_all order to DB + alert Research |
| Fee parameters changed | HIGH | Alert Research, log to DB |
| Ownership transferred | HIGH | Alert Research, log to DB |
| Blacklist function called | CRITICAL | Write sell_all order to DB + alert Research |

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

For non-critical alerts, batch them and send as a summary.

## Writing Sell Orders to DB

When a CRITICAL or HIGH condition triggers a sell, write the order to the database so the Executor agent picks it up automatically:

```bash
node scripts/db-query.js add-sell-order --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "sell_all",
  "reason": "stop_loss_hit",
  "trigger_price": 0.00045,
  "current_price": 0.00042,
  "severity": "critical",
  "source": "sentinel"
}'
```

For partial sells (e.g., take-profit levels):
```bash
node scripts/db-query.js add-sell-order --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "sell_partial",
  "sell_percent": 50,
  "reason": "tp1_hit",
  "trigger_price": 0.002,
  "current_price": 0.0021,
  "severity": "high",
  "source": "sentinel"
}'
```

The Executor agent polls for pending sell orders every heartbeat and executes them through the Safe wallet.

## Rules
- CRITICAL alerts go to human IMMEDIATELY — never wait for next heartbeat
- For CRITICAL events, write sell orders to DB right away — the Executor handles execution
- Log ALL alerts to daily memory, even false alarms (pattern learning)
- Sentinel does not execute trades — it writes sell orders and the Executor processes them
- Keep monitoring runs cheap — use scripts for data, LLM only for decision-making

## Paper Mode

When `PAPER_MODE=true`, the entire workflow above applies but position queries use paper commands:

| Action | Real Mode | Paper Mode |
|--------|-----------|------------|
| Get positions | `get-positions --status open` | `get-paper-positions --status open` |
| Get specific position | `get-positions --symbol TOKEN` | `get-paper-positions --symbol TOKEN` |

Everything else is identical:
- Monitoring scripts (check-positions.js, check-liquidity.js, check-wallets.js) run the same
- Sell orders are written to `sell_orders` table (Executor handles paper routing)
- Alerts are written to `sentinel_alerts` table (unchanged)
