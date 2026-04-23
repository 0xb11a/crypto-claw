# HEARTBEAT.md — CryptoClaw Monitoring Checklist

## Rotating Checks

On each heartbeat, determine which check is most overdue and run ONE check per heartbeat to minimize token usage.

### Check Schedule

| Check | Cadence | Active Hours | Priority |
|-------|---------|-------------|----------|
| Position health | every 15 min | 24/7 | CRITICAL |
| Price alerts (stop-loss / TP) | every 15 min | 24/7 | CRITICAL |
| Liquidity monitor | every 30 min | 24/7 | HIGH |
| New token scan | every 2 hours | 08:00-00:00 | NORMAL |
| Smart money buy signals | every 30 min | 08:00-00:00 | NORMAL |
| Narrative trend check | every 4 hours | 08:00-22:00 | LOW |
| Portfolio rebalance review | every 24 hours | 10:00 | LOW |
| Daily P&L summary | every 24 hours | 22:00 | LOW |

### State Tracking

Read and update `memory/heartbeat-state.json` to track last-run timestamps:
```json
{
  "position_health": "2026-03-02T10:00:00Z",
  "price_alerts": "2026-03-02T10:00:00Z",
  "liquidity_monitor": "2026-03-02T09:30:00Z",
  "token_scan": "2026-03-02T08:00:00Z",
  "smart_money_signals": "2026-03-02T09:00:00Z",
  "narrative_check": "2026-03-02T06:00:00Z",
  "rebalance_review": "2026-03-01T10:00:00Z",
  "daily_summary": "2026-03-01T22:00:00Z"
}
```

### How Each Check Works

**Position Health** (CRITICAL)
- Run `scripts/check-positions.ts` to get current prices for all open positions
- Compare against stop-loss and take-profit levels
- If any stop-loss hit → ALERT human immediately with sell proposal
- If any TP hit → ALERT human with partial sell proposal
- If position dropped >20% in last check interval → ALERT
- Log results to daily memory

**Price Alerts** (CRITICAL)
- Same as position health but also checks watchlist tokens for entry targets
- If a watchlisted token hits target entry price → notify human

**Liquidity Monitor** (HIGH)
- Run `scripts/check-liquidity.ts` for all open positions
- If any token's liquidity dropped >15% since last check → ALERT
- If any token's liquidity dropped >30% in 1 hour → CRITICAL ALERT, propose exit

**New Token Scan** (NORMAL)
- Run `scripts/scan-tokens.ts` to check DEXScreener trending + new deployments
- Filter through discovery criteria (see AGENTS.md)
- If promising tokens found → log to daily memory, run analysis skill
- If nothing → HEARTBEAT_OK

**Smart Money Buy Signals** (NORMAL)
- Read aggregated buy signals from the activity-wallets-bg loop:
  `node scripts/db-query.js get-smart-money-signals --since 35m --action buy --group-by token --min-wallets 2`
- Each row = a token where ≥2 distinct smart_money wallets bought in last 35 min
- For each: dedup via `check-token-status`, then run analysis → risk → trade proposal
- Producer (`activity-wallets-bg.js`) runs every 30 min, polls 10 wallets/cycle by oldest `last_checked_at`. Signals retained 24 h.
- Sentinel separately consumes `--action sell --tokens-in-positions` from the same table for exit alerts

**Narrative Trend** (LOW)
- Assess which narratives are gaining/losing momentum
- Log observations to daily memory
- Update MEMORY.md if narrative shift detected

**Portfolio Rebalance Review** (LOW)
- Calculate current allocation vs targets
- If any tier off by >5% → propose rebalance to human
- Log allocation snapshot to daily memory

**Daily P&L Summary** (LOW)
- Compile: total portfolio value, daily change, open P&L per position
- Send summary to human
- Log to daily memory

## Rules
- If nothing needs attention → reply HEARTBEAT_OK
- NEVER execute trades during heartbeat — only PROPOSE and ALERT
- Keep heartbeat runs cheap — use scripts for data, save LLM for decisions
- Critical checks take priority over normal/low checks
