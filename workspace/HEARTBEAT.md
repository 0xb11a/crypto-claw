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
| Smart money wallet activity | every 1 hour | 08:00-00:00 | NORMAL |
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
  "smart_money": "2026-03-02T09:00:00Z",
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

**Smart Money Tracking** (NORMAL)
- Run `scripts/check-wallets.ts` for tracked smart money wallets
- Log any new positions they've entered
- If a smart money wallet buys something we're watching → flag it

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
