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
| Price hit stop-loss | CRITICAL | Propose sell_all to human |
| Price hit TP level | HIGH | Propose partial sell per TP plan |
| Price dropped >20% in 1 check | HIGH | Alert human, reassess |
| Price dropped >40% since entry | CRITICAL | Propose exit |
| Price up >100% with no fundamentals change | MEDIUM | Consider taking partial profit |

### Liquidity Monitoring
```bash
node scripts/check-liquidity.js
```

| Condition | Severity | Action |
|-----------|----------|--------|
| LP removed >30% in 1 hour | CRITICAL | Alert + propose sell_all |
| LP removed >15% in 24 hours | HIGH | Alert human |
| LP increased significantly | INFO | Log as positive signal |
| LP provider count dropping | MEDIUM | Watch closely |

### Wallet Activity
```bash
node scripts/check-wallets.js --positions
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Dev wallet selling ANY amount | HIGH | Alert human immediately |
| Whale selling >3% of supply | HIGH | Alert + assess impact |
| Multiple early buyers exiting | MEDIUM | Alert human |
| Smart money accumulating | INFO | Log as positive signal |

### Contract Monitoring
```bash
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN> --changes
```

| Condition | Severity | Action |
|-----------|----------|--------|
| Proxy implementation changed | CRITICAL | Alert + propose sell_all |
| Fee parameters changed | HIGH | Alert human |
| Ownership transferred | HIGH | Alert human |
| Blacklist function called | CRITICAL | Alert + propose sell_all |

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

## Rules
- CRITICAL alerts go to human IMMEDIATELY — never wait for next heartbeat
- For CRITICAL events, bias toward "propose sell" over "wait and see"
- Log ALL alerts to daily memory, even false alarms (pattern learning)
- Never execute sells without human approval (except if configured for auto-stop-loss)
- Keep monitoring runs cheap — use scripts for data, LLM only for decision-making
