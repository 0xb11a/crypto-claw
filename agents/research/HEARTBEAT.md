# HEARTBEAT.md — Research Agent

## Schedule
Research heartbeat runs every 30 minutes. Run ALL overdue checks each heartbeat — quick checks first, then one pipeline check.

## Rotating Checks

| Check | Cadence | Active Hours | Type |
|-------|---------|-------------|------|
| Check sentinel alerts | every 30 min | 24/7 | quick |
| Market regime check | every 1 hour | 24/7 | quick |
| New token scan | every 2 hours | 24/7 | pipeline |
| Conviction token scan | every 6 hours | 24/7 | pipeline |
| Smart money wallet activity | every 1 hour | 24/7 | quick |
| Narrative trend check | every 4 hours | 24/7 | quick |
| Narrative deep scan | every 4 hours | 24/7 | pipeline |
| Portfolio rebalance review | every 12 hours | 24/7 | quick |
| Base tier rebalance check | every 12 hours | 24/7 | quick |
| Daily P&L summary | every 24 hours | 24/7 | quick |
| Watchlist entry check | every 1 hour | 24/7 | quick |
| Portfolio sync (on-chain) | every 6 hours | 24/7 | quick |

**Check types:**
- **Quick** — Single script call + log. Fast, no token pipeline. Run ALL that are overdue.
- **Pipeline** — Triggers discovery→analysis→risk→proposal. Heavy, multi-step. Run only ONE per heartbeat (the most overdue).

## Overlap Guard (run FIRST, before any work)

1. Get the cron job ID: run `openclaw cron list --json`. The output may be a JSON array directly `[...]` or an object with a `jobs` key `{"jobs":[...]}`. Either way, find the entry with `"name": "research-cycle"` and extract its `id`.
2. Run `openclaw cron runs --id <extracted-id> --limit 5`. The output is an object with an `entries` array.
3. The most recent entry in the list is YOU — skip it
4. If any OTHER entry has `action` other than `"finished"` (e.g. `"running"`, `"started"`): reply `HEARTBEAT_SKIP: previous run still active (run <sessionId>)` and stop immediately
5. If any command fails or the output format is unexpected, proceed normally (don't block on guard failure)
6. If no other run is active → continue to the steps below

## How to Run

1. Run overlap guard (see above)
2. Run `node scripts/db-query.js get-overdue-checks --agent research` — returns checks that are due (cadence computed server-side, do NOT override or add extra checks).
3. Read the `overdue` array from the output. If empty, skip to step 7.
4. Split overdue checks into two groups using the Type column above:
   - **Quick checks**: `sentinel_alerts`, `market_regime`, `smart_money`, `narrative_check`, `rebalance_review`, `daily_summary`, `watchlist_check`, `portfolio_sync`, `base_rebalance`
   - **Pipeline checks**: `token_scan`, `conviction_scan`, `narrative_deep_scan`
5. Run ALL overdue quick checks, in the order they appear in the table (highest-cadence first). After each, update its timestamp:
   `node scripts/db-query.js update-heartbeat --agent research --check <check_type>`
6. Run the SINGLE most-overdue pipeline check (if any pipeline check is overdue). **Run the FULL pipeline autonomously: discovery → analysis → risk → trade proposal.** Do not stop after scanning. You decide what to buy — that is your job. Update its timestamp after completion.
7. If no checks are overdue at all, reply with a short "nothing overdue" summary and skip to step 9.
8. **REQUIRED — Reply with a work summary** (always). This is your final message and it will be delivered to chat. List every check that ran this cycle. Format:
   ```
   **Research Heartbeat** — <check_1>, <check_2>, ..., <check_N>
   - <check_1>: <one-line result>
   - <check_2>: <one-line result>
   - ...
   Scanned: <N> | Analyzed: <N> | Proposed: <N>
   ```
   Examples:
   - **Research Heartbeat** — sentinel_alerts, market_regime, token_scan
     - sentinel_alerts: No unprocessed alerts
     - market_regime: Unchanged (neutral)
     - token_scan: Scanned 30 trending on base+solana, analyzed 2 (AERO, VIRTUAL). Proposed 1 BUY (AERO moonshot)
     Scanned: 30 | Analyzed: 2 | Proposed: 1
   - **Research Heartbeat** — sentinel_alerts, smart_money, watchlist_check
     - sentinel_alerts: 1 alert processed (LP drop on $TOKEN)
     - smart_money: No new activity
     - watchlist_check: 0 tokens hit target entry
     Scanned: 0 | Analyzed: 0 | Proposed: 0
9. **REQUIRED — Log to database** (one entry PER check that ran — do NOT skip this step):
   ```bash
   node scripts/db-query.js add-research-log --json '{"check_type":"<CHECK>","tokens_scanned":<N>,"tokens_analyzed":<N>,"trades_proposed":<N>,"alerts_processed":<N>,"watchlist_hits":<N>,"summary":"<one-line summary>","status":"ok"}'
   ```
   - Write one `add-research-log` call for EACH check that ran this cycle
   - `tokens_scanned`: tokens that passed initial filters. `tokens_analyzed`: those that went through the full pipeline.
   - `summary`: one human-readable sentence for that specific check
   - **If a check failed partway through (script crash, malformed JSON, DB error, memory_search error, etc.):** you MUST log `status: "error"` AND fire `node scripts/send-alert.js --type model_failure --agent research --message "<check_type> failed: <reason>"`. A failed check with no log row — or with a log row but no alert — is itself a bug (Observer detects this as a silent crash). See AGENTS.md § Error Self-Reporting.

## Check Details

**Check Sentinel Alerts** (quick — always first priority)
- Run `node scripts/db-query.js get-alerts --unprocessed`
- If new alerts exist: process them, log to daily memory, notify human if needed
- Mark processed: `node scripts/db-query.js mark-alert-processed --id <alert_id>`

**New Token Scan** (pipeline)
- Run `node scripts/scan-tokens.js --chain all --sort trending --limit 50`
- Filter through discovery skill criteria
- Log discoveries to daily memory
- **For each promising token: immediately run the full pipeline** (analysis → risk → trade proposal). Do NOT stop after scanning — proceed through every stage until you either propose a trade or reject the token. This is autonomous operation.

**Smart Money** (quick)
- Run `node scripts/check-wallets.js` (only checks scored wallets)
- Log new activity, flag if smart money enters a watched token
- Wallet harvesting is self-seeding: the background scorer fetches Birdeye top 100 gainers for every active chain once per hour (~300 wallets/harvest). Scoring runs every 10 min, harvesting every 60 min (Birdeye free tier budget). No manual seeding needed.
- For deployer wallets from check-contract.js, propose manually:
  `node scripts/db-query.js propose-wallet --json '{"address":"<ADDR>","chain":"<CHAIN>","label":"<LABEL>","source_token":"<TOKEN_ADDR>"}'`
- Background scorer runs every 10 min (batch size 10, 3s delay) — wallets scoring 55+ auto-classified as whale/smart_money
- For urgent wallets (multi-token overlap), score inline: `node scripts/score-wallet.js --address <ADDR> --chain <CHAIN> --add`

**Conviction Token Scan** (pipeline)
- Run `node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30`
- Filter through discovery skill conviction criteria (age >7d, liquidity >$100k, verified)
- Cross-reference with `node scripts/narrative-check.js` for momentum
- For each promising token: run full pipeline (analysis → risk → trade proposal with tier=conviction)

**Market Regime Check** (quick)
- Run `node scripts/market-regime.js`
- Log the regime and any transition to daily memory with `[MARKET]` tag
- If regime changed: log the old → new transition and adjusted parameters
- The script auto-updates `portfolio_meta` (key: `market_regime`) and heartbeat timestamp
- Other checks read regime from DB — this check keeps it fresh

**Base Tier Rebalance Check** (quick)
- **First:** read market regime from DB: `node scripts/db-query.js get-meta --key market_regime`
- If regime is `bearish` or `crisis` (`baseBuyingEnabled: false`): log "Base tier buying paused — market regime: {regime}" and skip
- Check current base allocation vs 50% target
- If base < 40%: propose buying the most underweight base asset per chain (query `get-chain-config --chain <CHAIN>` for `baseTierTokens`) — only for chains where `base` is in `tiersEnabled`
- Use `node scripts/token-metrics.js --address <BASE_TOKEN_ADDRESS> --chain <CHAIN>` to get current prices for sizing
- Base buys skip discovery/analysis pipeline — go straight to risk check + trade proposal
- Risk check for base tokens is simplified: verify liquidity, check portfolio limits, confirm price isn't at extreme (>20% above 7d avg)

**Narrative Trends** (quick)
- Run `node scripts/narrative-check.js`
- Now checks 26 narratives (was 8) — AI infra, AI agents, DeFi, restaking, LST, yield, RWA, L2, ZK, modular, DePIN, memecoins, gaming, SocialFi, prediction markets, BTC ecosystem, privacy, Telegram/TON, and more
- Log momentum shifts, update MEMORY.md if narrative changes
- Check `rotations` array in output — log any narrative rotation events with `[NARRATIVE-ROTATION]` tag

**Narrative Deep Scan** (pipeline)
- Run AFTER narrative trend check (uses its momentum data)
- Run `node scripts/narrative-deep-scan.js --narrative all --hot-only --quick`
- Returns top 3 tokens per hot/warming narrative (lightweight agent mode)
- For each token in results: run through dedup (Step 1.5 of discovery) then full pipeline (analysis → risk → trade proposal)
- This is the primary mechanism for narrative-driven discovery — it finds the BEST tokens in each pumping narrative

**Rebalance Review** (quick)
- Check `PAPER_MODE` env var first
- If `PAPER_MODE=true`: run `node scripts/db-query.js get-paper-portfolio --chain <chain>` and `node scripts/db-query.js get-paper-cash --chain <chain>`
- If real mode: run `node scripts/portfolio-summary.js --chain <chain>`
- Check allocation vs targets, propose rebalance if needed

**Cache Cleanup** (run during daily summary)
- Run `node scripts/db-query.js clear-expired-cache` to prune stale analysis cache entries

**Daily Summary** (quick)
- Check `PAPER_MODE` env var first
- If `PAPER_MODE=true`: use `get-paper-portfolio --chain <chain>`, `get-paper-stats --chain <chain>`, `get-paper-receipts --limit 20`
- If real mode: use `get-portfolio --chain <chain>`, `get-trade-stats`, `get-receipts --limit 20`
- Compile: total value, daily P&L, trades executed, alerts
- The system sends a daily portfolio Telegram alert separately — just compile the summary in your reply and log to daily memory

**Watchlist Entry Check** (quick)
- Run `node scripts/db-query.js get-watchlist --active`
- For each watchlisted token, check if target entry price hit
- If hit → run through analysis → risk → propose trade

**Portfolio Sync (On-Chain)** (quick)
- Real mode only — skip entirely if `PAPER_MODE=true`
- Read active chains via `get-chains`. For EACH active chain, run the appropriate loader based on chain type:
  - EVM chains: `node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger periodic`
  - Solana chains: `node scripts/portfolio-load-solana.js --chain <CHAIN> --trigger periodic`
- After sync, check for auto-discovered tokens: `node scripts/db-query.js get-positions --status pending_analysis`
- If found: run full pipeline on each (analysis → risk → categorize/propose)
- Log sync results to daily memory with `[SYNC]` tag
