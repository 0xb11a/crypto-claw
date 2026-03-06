# HEARTBEAT.md — Research Agent

## Schedule
Research heartbeat runs every 30 minutes. One check per heartbeat.

## Rotating Checks

| Check | Cadence | Active Hours |
|-------|---------|-------------|
| Check sentinel alerts | every 30 min | 24/7 |
| New token scan | every 2 hours | 08:00-00:00 |
| Smart money wallet activity | every 1 hour | 08:00-00:00 |
| Narrative trend check | every 4 hours | 08:00-22:00 |
| Portfolio rebalance review | every 24 hours | 10:00 |
| Daily P&L summary | every 24 hours | 22:00 |
| Watchlist entry check | every 1 hour | 08:00-00:00 |

## How to Run

1. Read `memory/heartbeat-state.json` for last-run timestamps
2. Determine which check is most overdue (respect active hours)
3. Run that ONE check
4. Update timestamp in `memory/heartbeat-state.json`
5. If check finds something actionable → log + alert human
6. If nothing → reply HEARTBEAT_OK

## Check Details

**Check Sentinel Alerts** (always first priority)
- Read `memory/sentinel-alerts.json`
- If new alerts exist: process them, log to daily memory, notify human if needed
- Clear processed alerts

**New Token Scan**
- Run `node scripts/scan-tokens.js --chain all --sort trending --limit 30`
- Filter through discovery skill criteria
- Log discoveries, trigger analysis if promising

**Smart Money**
- Run `node scripts/check-wallets.js`
- Log new activity, flag if smart money enters a watched token

**Narrative Trends**
- Run `node scripts/narrative-check.js`
- Log momentum shifts, update MEMORY.md if narrative changes

**Rebalance Review**
- Run `node scripts/portfolio-summary.js`
- Check allocation vs targets, propose rebalance if needed

**Daily Summary**
- Compile: total value, daily P&L, trades executed, alerts
- Send to human, log to daily memory

**Watchlist Entry Check**
- Read `memory/watchlist.json`
- For each watchlisted token, check if target entry price hit
- If hit → run through analysis → risk → propose trade
