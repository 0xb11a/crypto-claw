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
| Smart-money buy signals | every 30 min | 24/7 | quick |
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
2. Run `cclaw heartbeat overdue --agent research` — returns checks that are due (cadence computed server-side, do NOT override or add extra checks).
3. Read the `overdue` array from the output. If empty, your reply IS the summary: a single line `**Research Heartbeat** — nothing overdue`. End the cycle — no further steps (no log rows to write either, since no checks ran).
4. Split overdue checks into two groups using the Type column above:
   - **Quick checks**: `sentinel_alerts`, `market_regime`, `smart_money_signals`, `narrative_check`, `rebalance_review`, `daily_summary`, `watchlist_check`, `portfolio_sync`, `base_rebalance`
   - **Pipeline checks**: `token_scan`, `conviction_scan`, `narrative_deep_scan`
5. Run ALL overdue quick checks, in the order they appear in the table (highest-cadence first). After each, update its timestamp:
   `cclaw heartbeat ping --agent research --check <check_type>`
6. Run the SINGLE most-overdue pipeline check (if any pipeline check is overdue). **Run the FULL pipeline autonomously: discovery → analysis → risk → trade proposal.** Do not stop after scanning. You decide what to buy — that is your job. Update its timestamp after completion.
7. **Reply with a work summary** (required whenever at least one check ran). This is your final message and is delivered to chat. List every check that ran this cycle. Format:
   ```
   **Research Heartbeat** — <check_1>, <check_2>, ..., <check_N>
   - <check_1>: <one-line result>
   - <check_2>: <one-line result>
   Scanned: <N> | Analyzed: <N> | Proposed: <N>
   ```
   Example:
   - **Research Heartbeat** — sentinel_alerts, market_regime, token_scan
     - sentinel_alerts: No unprocessed alerts
     - market_regime: Unchanged (neutral)
     - token_scan: Scanned 30 trending on base+solana, analyzed 2 (AERO, VIRTUAL). Proposed 1 BUY (AERO moonshot)
     Scanned: 30 | Analyzed: 2 | Proposed: 1
8. **REQUIRED — Log to database** (one entry PER check that ran — do NOT skip this step):
   ```bash
   node scripts/db-query.js add-research-log --json '{"check_type":"<CHECK>","tokens_scanned":<N>,"tokens_analyzed":<N>,"trades_proposed":<N>,"alerts_processed":<N>,"watchlist_hits":<N>,"summary":"<one-line summary>","status":"ok"}'
   ```
   - Write one `add-research-log` call for EACH check that ran this cycle
   - `tokens_scanned`: tokens that passed initial filters. `tokens_analyzed`: those that went through the full pipeline.
   - `summary`: one human-readable sentence for that specific check
   - **If a check failed partway through (script crash, malformed JSON, DB error, memory_search error, etc.):** you MUST log `status: "error"` AND fire `cclaw alerts send --type model_failure --agent research --message "<check_type> failed: <reason>"`. A failed check with no log row — or with a log row but no alert — is itself a bug (Observer detects this as a silent crash). See AGENTS.md § Error Self-Reporting.
   - Note: `add-research-log` is a legacy hold-back; use `node scripts/db-query.js add-research-log` until a `cclaw agent-logs create` command is available (pending P5b).

## Check Details

### Check Sentinel Alerts (quick — always first priority)
- Run `cclaw alerts list --unprocessed`
- If new alerts exist: process them and log to daily memory. Notify the human via `cclaw alerts send --type sentinel_alert_followup --agent research --message "<decision>"` only when the alert led to a concrete decision (sell-order written, watchlist update, position re-tier). Routine processing produces no Telegram message.
- Mark processed: `cclaw alerts ack --id <alert_id>`

### New Token Scan (pipeline)
- Run token discovery via the discovery skill (see TOOLS.md). [cclaw expansion pending P5b — `cclaw market scan` not yet implemented; use the discovery skill which calls the available data APIs]
- Filter through discovery skill criteria
- Log discoveries to daily memory
- **For each promising token: immediately run the full pipeline** (analysis → risk → trade proposal). Do NOT stop after scanning — proceed through every stage until you either propose a trade or reject the token. This is autonomous operation.

### Smart-Money Signals (quick)
- Read aggregated BUY signals (≥2 distinct `smart_money` wallets in last 35 min):
  ```bash
  node scripts/db-query.js get-smart-money-signals --since 35m --action buy --group-by token --min-wallets 2
  ```
  The 35-min window absorbs 5 min of cron jitter on the 30-min cadence; the discovery skill uses a wider 6-h window for pre-trade context. Both windows are intentional — do not collapse them.
  Note: `get-smart-money-signals` is a legacy hold-back; use `node scripts/db-query.js get-smart-money-signals` until a `cclaw wallets signals` command is available (pending P5b).
- For each token returned, run dedup via `check-token-status`, then the full pipeline (analysis → risk → trade proposal). Treat as high-urgency discoveries.
- For deployer wallets, call `propose-wallet` (db-query.js hold-back; see TOOLS.md). Background wallet scoring (WalletScoringProcessor, every 10 min via NestJS worker) and signal production (WalletActivityProcessor, every 30 min, 24 h retention) run autonomously — heartbeat only consumes. See CLAUDE.md § Wallet Pipeline for the full flow.

### Conviction Token Scan (pipeline)
- Run conviction token discovery via the discovery skill (see TOOLS.md). [cclaw expansion pending P5b — `cclaw market scan --sort established` not yet implemented]
- Filter through discovery skill conviction criteria (age >7d, liquidity >$100k, verified)
- Cross-reference with narrative momentum data (db-query.js `get-meta --key market_regime`, or read from recent research_log)
- For each promising token: run full pipeline (analysis → risk → trade proposal with tier=conviction)

### Market Regime Check (quick)
- Read current regime: `node scripts/db-query.js get-meta --key market_regime` (legacy hold-back — `cclaw system meta` pending P5b). [cclaw expansion pending P5b — `cclaw market regime` not yet implemented; regime is now set by MarketRegimeProcessor (NestJS worker)]
- Log the current regime and any transition to daily memory with `[MARKET]` tag
- If regime changed (compare against last heartbeat's logged value): log the old → new transition and adjusted parameters
- Other checks read regime from DB — this check keeps it fresh

### Base Tier Rebalance Check (quick)
- **First:** read market regime from DB: `node scripts/db-query.js get-meta --key market_regime` (legacy hold-back — `cclaw system meta` pending P5b)
- If regime is `bearish` or `crisis` (`baseBuyingEnabled: false`): log "Base tier buying paused — market regime: {regime}" and skip
- For each chain where `base` is in `tiersEnabled` (from `get-chain-config --chain <CHAIN>`), use `maxBasePosition` from that config as the cap (see AGENTS.md § Base Tier Rebalancing)
- If a base position drops below `maxBasePosition / 2`: propose buying that asset up to the target (`maxBasePosition − 10%`); pick the most underweight per chain from `baseTierTokens`
- Use `cclaw positions get --id <ID>` for position data, or get current prices via the market data available in your context [cclaw expansion pending P5b — `cclaw market price` not yet implemented]
- Base buys skip discovery/analysis pipeline — go straight to risk check + trade proposal
- Risk check for base tokens is simplified: verify liquidity, check portfolio limits, confirm price isn't at extreme (>20% above 7d avg)

### Narrative Trends (quick)
- [cclaw expansion pending P5b — `cclaw market narrative` not yet implemented; narrative momentum data is not currently surfaced via cclaw CLI]
- Assess narrative momentum based on recent Research discoveries logged in MEMORY.md and today's daily log.
- Log momentum shifts, update MEMORY.md if narrative changes
- Log any narrative rotation events with `[NARRATIVE-ROTATION]` tag

### Narrative Deep Scan (pipeline)
- [cclaw expansion pending P5b — `cclaw market narrative-scan` not yet implemented]
- Use recent discovery data from MEMORY.md and daily logs to identify hot narratives.
- For each hot-narrative token candidate: run dedup with `node scripts/db-query.js check-token-status --address <ADDR> --chain <CHAIN>` (legacy hold-back) (skip on `action: "skip"`), then full pipeline (analysis → risk → trade proposal)
- This is the primary mechanism for narrative-driven discovery — it finds the BEST tokens in each pumping narrative

### Rebalance Review (quick)
- Run `cclaw positions list --chain <chain>` and `node scripts/db-query.js get-cash --chain <chain>` (get-cash is legacy hold-back)
- Check allocation vs targets, propose rebalance if needed

### Daily Summary (quick)
- `cclaw positions list --chain <chain>`, `node scripts/db-query.js get-trade-stats --chain <chain>` (legacy hold-back), `cclaw receipts list --limit 20`
- Compile: total value, daily P&L, trades executed, alerts
- The system sends a daily portfolio Telegram alert separately — just compile the summary in your reply and log to daily memory
- Run `node scripts/db-query.js clear-expired-cache` to prune stale analysis cache entries (legacy hold-back)

### Watchlist Entry Check (quick)
- Run `node scripts/db-query.js get-watchlist --active` (legacy hold-back — `cclaw watchlist list` pending P5b)
- For each watchlisted token, check if target entry price hit
- If hit → run through analysis → risk → propose trade

### Portfolio Sync (On-Chain) (quick)
- [cclaw expansion pending P5b — `cclaw portfolio sync` not yet implemented; on-chain portfolio sync is now handled by the PortfolioSyncProcessor (NestJS worker) automatically]
- Read active chains via `node scripts/db-query.js get-chains` (legacy hold-back).
- Check for auto-discovered tokens: `cclaw positions list --status pending_analysis`
- If found: run full pipeline on each (analysis → risk → categorize/propose)
- Log sync results to daily memory with `[SYNC]` tag
