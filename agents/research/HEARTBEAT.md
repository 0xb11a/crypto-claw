# HEARTBEAT.md — Research Agent

## Schedule
Research heartbeat runs every 30 minutes. One check per heartbeat.

## Rotating Checks

| Check | Cadence | Active Hours |
|-------|---------|-------------|
| Check sentinel alerts | every 30 min | 24/7 |
| Market regime check | every 1 hour | 24/7 |
| New token scan | every 2 hours | 08:00-00:00 |
| Conviction token scan | every 6 hours | 08:00-22:00 |
| Smart money wallet activity | every 1 hour | 08:00-00:00 |
| Narrative trend check | every 4 hours | 08:00-22:00 |
| Portfolio rebalance review | every 24 hours | 10:00 |
| Base tier rebalance check | every 12 hours | 10:00, 22:00 |
| Daily P&L summary | every 24 hours | 22:00 |
| Watchlist entry check | every 1 hour | 08:00-00:00 |

## How to Run

1. Read `memory/heartbeat-state.json` for last-run timestamps
2. Determine which check is most overdue (respect active hours)
3. Run that check
4. Update timestamp in `memory/heartbeat-state.json`
5. **If the check produces discoveries → run the FULL pipeline autonomously: discovery → analysis → risk → trade proposal.** Do not stop after scanning. You decide what to buy — that is your job.
6. If nothing actionable → reply HEARTBEAT_OK

## Check Details

**Check Sentinel Alerts** (always first priority)
- Read `memory/sentinel-alerts.json`
- If new alerts exist: process them, log to daily memory, notify human if needed
- Clear processed alerts

**New Token Scan**
- Run `node scripts/scan-tokens.js --chain all --sort trending --limit 30`
- Filter through discovery skill criteria
- Log discoveries to daily memory
- **For each promising token: immediately run the full pipeline** (analysis → risk → trade proposal). Do NOT stop after scanning — proceed through every stage until you either propose a trade or reject the token. This is autonomous operation.

**Smart Money**
- Run `node scripts/check-wallets.js` (only checks scored wallets)
- Log new activity, flag if smart money enters a watched token
- If new interesting wallets appear (from holder-distribution, check-contract), propose them for background scoring:
  `node scripts/db-query.js propose-wallet --json '{"address":"<ADDR>","chain":"<CHAIN>","label":"<LABEL>","source_token":"<TOKEN_ADDR>"}'`
- Background scorer runs every 10 min — wallets scoring 55+ auto-classified as whale/smart_money
- For urgent wallets (multi-token overlap), score inline: `node scripts/score-wallet.js --address <ADDR> --chain <CHAIN> --add`

**Conviction Token Scan**
- Run `node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30`
- Filter through discovery skill conviction criteria (age >7d, liquidity >$100k, verified)
- Cross-reference with `node scripts/narrative-check.js` for momentum
- For each promising token: run full pipeline (analysis → risk → trade proposal with tier=conviction)

**Market Regime Check**
- Run `node scripts/market-regime.js`
- Log the regime and any transition to daily memory with `[MARKET]` tag
- If regime changed: log the old → new transition and adjusted parameters
- The script auto-updates `portfolio_meta` (key: `market_regime`) and heartbeat timestamp
- Other checks read regime from DB — this check keeps it fresh

**Base Tier Rebalance Check**
- **First:** read market regime from DB: `node scripts/db-query.js get-meta --key market_regime`
- If regime is `bearish` or `crisis` (`baseBuyingEnabled: false`): log "Base tier buying paused — market regime: {regime}" and skip
- Check current base allocation vs 50% target
- If base < 40%: propose buying the most underweight base asset per chain (Base chain: WETH/cbBTC, Solana: wSOL)
- Use `node scripts/token-metrics.js --address <BASE_TOKEN_ADDRESS> --chain <CHAIN>` to get current prices for sizing
- Base buys skip discovery/analysis pipeline — go straight to risk check + trade proposal
- Risk check for base tokens is simplified: verify liquidity, check portfolio limits, confirm price isn't at extreme (>20% above 7d avg)

**Narrative Trends**
- Run `node scripts/narrative-check.js`
- Log momentum shifts, update MEMORY.md if narrative changes

**Rebalance Review**
- Check `PAPER_MODE` env var first
- If `PAPER_MODE=true`: run `node scripts/db-query.js get-paper-portfolio` and `node scripts/db-query.js get-paper-cash`
- If real mode: run `node scripts/portfolio-summary.js`
- Check allocation vs targets, propose rebalance if needed

**Daily Summary**
- Check `PAPER_MODE` env var first
- If `PAPER_MODE=true`: use `get-paper-portfolio`, `get-paper-stats`, `get-paper-trades --limit 20`
- If real mode: use `get-portfolio`, `get-trade-stats`, `get-receipts --limit 20`
- Compile: total value, daily P&L, trades executed, alerts
- Send to human, log to daily memory

**Watchlist Entry Check**
- Read `memory/watchlist.json`
- For each watchlisted token, check if target entry price hit
- If hit → run through analysis → risk → propose trade
