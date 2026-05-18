<!-- Full reference — not deployed to agents. Per-agent versions live in agents/{name}/TOOLS.md -->
# TOOLS.md — CryptoClaw Tool Usage Guide

## General Notes
- All scripts output **valid JSON to stdout**. You can read the output directly — no need to pipe through `jq` unless you want to extract a specific field.
- `jq` is available in the container if needed (e.g., `node scripts/scan-tokens.js | jq '.tokens[0].symbol'`).
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below — they call the APIs directly.

## Logging Severity Rubric (canonical)

`scripts/log.js` supports four levels. Every script and agent uses them with this meaning — Observer's detection rules depend on it.

| Level | Meaning | Example | Observer response |
|-------|---------|---------|-------------------|
| `info` | Routine step completed. Never actionable. | `scan complete: 30 tokens` | Ignored |
| `warn` | **Degraded but self-healing.** One retry succeeded, cache miss, fallback source used. | `birdeye 429 — fell back to dexscreener` | Sampled for patterns (>5 same warn / 30 min = GitHub issue) |
| `error` | **An operation did not complete.** A DB write failed, a pipeline aborted, an order was not created. | `cclaw orders propose failed: SQLITE_LOCKED` | Each instance is actionable — Observer correlates and files a GitHub issue |
| `critical` | **Safety/integrity violation.** Possible key leak, emergency-mode trigger, signer drained, data corruption, stuck heartbeat. | `SAFE_SIGNER_KEY missing; refusing execution` | Immediate Telegram alert on next Observer cycle |

**Rule of thumb for agents and script authors:**
- If the work still finished correctly after a retry/fallback → `warn`.
- If the work didn't finish, or was skipped without producing the expected artifact (order, receipt, log row) → `error`.
- If the failure threatens capital or exposes a secret → `critical`.

Never log an unhandled exception at `warn` — Observer will not treat it as actionable per-instance, and the failure will go invisible.

## Database CLI (`cclaw`)

All wallet data (positions, trades, orders, alerts, receipts) lives in a SQLite database. Access it through `cclaw <resource> <action>` (canonical post-P5b) — never access the DB file directly. The legacy `scripts/db-query.js` remains on disk for importers (`heartbeat-check.js`, `promote-pattern.js`, `emergency-*.js`) but is no longer invoked from agent markdown or developer workflows.

### Chain Discovery
```bash
# List all active chains
cclaw system chains
# → ["base","ethereum","solana"]

# Get config for a specific chain (RPC, explorer, cash token, Safe/Squads addresses)
cclaw system chain-config --chain <CHAIN>
```

### Portfolio & Cash
```bash
# Get full portfolio summary (all chains)
cclaw system portfolio

# Get per-chain portfolio (chain-specific cash + positions + value)
cclaw system portfolio --chain <CHAIN>

# Get cash balance (all chains breakdown)
cclaw system cash get
# Get per-chain cash
cclaw system cash get --chain <CHAIN>

# Set cash balance (requires --chain)
cclaw system cash set --chain <CHAIN> --amount 5000

# Get native gas balance (ETH/SOL — gas only, not a position)
cclaw system gas --chain <CHAIN>

# Get/set arbitrary metadata
cclaw system meta get --key my_key
cclaw system meta set --key my_key --value my_value
```

### Positions
```bash
# List positions (optionally filter by status and/or symbol)
cclaw positions list
cclaw positions list --status open
cclaw positions list --symbol TOKEN

# Get a single position
cclaw positions get --id pos-001

# Update a position's on-chain balance
cclaw positions set-onchain-balance --id pos-001 --balance 10000

# (Position create/close/update lifecycle is owned by ExecuteOrderProcessor — use cclaw orders propose/execute)
```

### Order Execution (Executor)
```bash
# Enqueue a single order for processing by ExecuteOrderProcessor (returns 202)
cclaw orders execute --id trade-001

# Check execution result (status progresses to executed/failed/rejected)
cclaw orders get --id trade-001
```

### Orders (Research/Sentinel → Executor)

Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).

```bash
# Get all orders (newest first)
cclaw orders list

# Get pending orders
cclaw orders list --pending

# Get approved orders ready for execution
cclaw orders list --status approved --action buy
cclaw orders list --status approved --action sell

# Get single order detail
cclaw orders get --id trade-001

# Order history (all statuses, newest first)
cclaw orders history --limit 20
cclaw orders history --status rejected

# Write a buy order (status auto-set: pending in real mode, approved if PAPER_MODE=true or AUTO_APPROVE_BUY=true)
cclaw orders propose --json '{
  "id": "trade-001",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "<CHAIN>",
  "amount": 500,
  "tier": "moonshot",
  "entry_price": 0.001,
  "stop_loss": 0.0005,
  "take_profit_levels": [{"level":1,"price":0.002,"sellPercent":50}],
  "reasoning": "Strong AI narrative play"
}'

# Write a sell order (auto-approved by sentinel)
cclaw orders propose --json '{
  "id": "sell-001",
  "action": "sell",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "<CHAIN>",
  "amount": "all",
  "reason": "stop_loss_hit",
  "urgency": "immediate"
}'

# Approve a pending order
cclaw orders approve --id trade-001 --by human

# Reject a pending order
cclaw orders reject --id trade-001 --reason "low liquidity"

# Cancel an approved or failed order (changed mind)
cclaw orders cancel --id trade-001 --reason "market changed" --by human

# Retry a failed sell order (re-queue for execution; buys cannot be retried)
cclaw orders retry --id sell-001 --by human
```

### Receipts (Executor → All)
```bash
# Get recent receipts
cclaw receipts list --limit 10

# Get receipts by status
cclaw receipts list --status tx_failed --limit 20
cclaw receipts list --status executed --limit 10

# (Receipts are written atomically by ExecuteOrderProcessor — not written manually)
```

### Sentinel Alerts (Sentinel → Research)
```bash
# Get unprocessed alerts
cclaw alerts list --unprocessed

# Write an alert
cclaw alerts create --json '{
  "id": "alert-001",
  "symbol": "TOKEN",
  "chain": "<CHAIN>",
  "alert_type": "liquidity_drop",
  "severity": "high",
  "details": "Liquidity dropped 25% in 5 minutes"
}'

# Mark alert as processed
cclaw alerts ack --id alert-001
```

### Watchlist
```bash
# Get current watchlist
cclaw watchlist list

# Get active watchlist entries
cclaw watchlist list --status active

# Add token to watchlist
cclaw watchlist add --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "<CHAIN>",
  "reason": "Smart money accumulation",
  "target_entry": 0.001
}'

# Update a watchlist entry
cclaw watchlist update --id <ID> --json '{"target_entry": 0.0009}'

# Remove from watchlist
cclaw watchlist remove --id <ID>
```

### Liquidity Snapshots
```bash
# Get latest liquidity for an address
cclaw liquidity list --address 0x... --chain <CHAIN>

# Save new snapshot
cclaw liquidity add --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots
```bash
# Get latest contract safety snapshots for an address
cclaw contracts list --address 0x... --chain <CHAIN>
cclaw contracts list --address 0x... --chain <CHAIN> --limit 10

# Save new contract safety snapshot
cclaw contracts add --address 0x... --chain <CHAIN> --json '<safety_data_json>'
```

### Wallet Tracking
```bash
# Get tracked wallets (all)
cclaw wallets list

# Get tracked wallets by status (proposed, scoring, scored, failed)
cclaw wallets list --status scored

# Get tracked wallets by type
cclaw wallets list --type smart_money

# Add a wallet (type: smart_money, dev, whale, deployer, trader, retail)
# If type is set, defaults to status='scored'; if null, status='proposed'
cclaw wallets add --json '{
  "address": "0x...",
  "chain": "<CHAIN>",
  "label": "Smart Money #3",
  "type": "smart_money"
}'

# Remove a tracked wallet
cclaw wallets remove --address 0x... --chain <CHAIN>
```

### Wallet Scoring Pipeline
```bash
# Propose a wallet for background scoring (fast, no API calls)
cclaw wallets propose --json '{
  "address": "0x...",
  "chain": "<CHAIN>",
  "label": "Top holder #3 of TOKEN",
  "source_token": "0xTokenAddr"
}'

# Get wallets waiting to be scored (proposed + failed with retry < 3)
cclaw wallets unscored
cclaw wallets unscored --limit 10

# Update a wallet's score (used by background scorer)
cclaw wallets update-score --address 0x... --chain <CHAIN> --json '{
  "score": 78,
  "type": "smart_money",
  "score_breakdown": {"profitability":85,"reputation":70,"volume":80,"activity":75,"consistency":60},
  "status": "scored"
}'
```
The background scorer (WalletScoringProcessor NestJS worker) runs every 10 minutes. Self-seeds by fetching Birdeye top 100 gainers for every active chain every 60 min (~300 wallets/harvest), then scores up to 10 wallets from the queue per cycle. Each scoring call also harvests token top traders (snowball effect). Wallets that fail scoring are retried up to 3 times.

The `source` column tracks how a wallet was discovered: `agent` (manually proposed), `leaderboard` (Birdeye top gainers), `token_traders` (Birdeye token top traders), `holder_extraction`.

### Heartbeat & Logs
```bash
# Check when agents last ran
cclaw heartbeat get --agent <agent_name>

# Get overdue checks (cadence enforced server-side — returns only checks that are due)
cclaw heartbeat overdue --agent <agent_name>

# Update heartbeat timestamp
cclaw heartbeat ping --agent research --check token_scan

# Write agent logs
cclaw logs sentinel append --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"status":"ok"}'
cclaw logs executor append --json '{"sell_orders_processed":1,"buy_orders_processed":0,"success_count":1,"status":"ok"}'
cclaw logs research append --json '{"check_type":"token_scan","tokens_scanned":30,"tokens_analyzed":2,"trades_proposed":1,"summary":"Scanned 30 trending, proposed 1 BUY","status":"ok"}'
cclaw logs research list --limit 10

# Trade statistics
cclaw system trade-stats
```

### Paper Mode (Simulated Trading)

Paper mode (`PAPER_MODE=true`) runs through the same pipeline as real mode. Orders auto-approve, Executor writes to `paper_receipts` and `paper_positions`. Starting cash set via `PAPER_STARTING_BALANCE` env var (default 10000). Paper lifecycle commands (add-paper-position, close-paper-position, set-paper-cash, etc.) are managed internally by ExecuteOrderProcessor — not invoked by agents directly.

```bash
# Paper mode queries via db-query.js (developer use only — not exposed via cclaw CLI)
# These are retained in db-query.js for backward compatibility but not part of the cclaw surface:
#   get-paper-portfolio, get-paper-positions, get-paper-receipts, get-paper-stats
#   get-paper-cash, set-paper-cash, add-paper-position, update-paper-position, etc.
```

### Portfolio Sync (On-Chain — Real Mode Only)
```bash
# Trigger on-chain portfolio sync for a chain (fire-and-forget; returns 202)
cclaw system sync-portfolio --chain <CHAIN>
cclaw system sync-portfolio --chain <CHAIN> --trigger post_trade

# Get last sync status (per chain)
cclaw system sync-status
cclaw system sync-status --chain <CHAIN>

# Update a position's on-chain balance
cclaw positions set-onchain-balance --id <position_id> --balance 1000.5
```
In paper mode, `cclaw system sync-portfolio` short-circuits (DB is sole source of truth).

### Analysis Cache (Token Dedup)
```bash
# Check if a token needs analysis (dedup before running analyst/risk skills)
# Returns action: "skip" or "analyze" with reason
cclaw analysis check --address 0x... --chain <CHAIN>
# → {"address":"0x...","chain":"<CHAIN>","action":"skip","reason":"open_position","details":{...}}
# → {"address":"0x...","chain":"<CHAIN>","action":"analyze","reason":"none"}
# Checks in order: open positions, pending buys, pending sells, watchlist, cached analysis

# Cache an avoid/reject verdict (prevents re-analysis for 24h by default)
cclaw analysis cache --json '{
  "address": "0x...",
  "chain": "<CHAIN>",
  "symbol": "TOKEN",
  "analysis_score": 25,
  "verdict": "avoid",
  "reasoning": "Low liquidity, unverified contract"
}'

# Cache with custom TTL (e.g., 12 hours)
cclaw analysis cache --json '{
  "address": "0x...",
  "chain": "<CHAIN>",
  "verdict": "risk_rejected",
  "risk_score": 82,
  "reasoning": "Top holder >30%",
  "ttl_hours": 12
}'

# List all unexpired cache entries (debugging)
cclaw analysis list

# Delete expired cache entries (run during daily summary)
cclaw analysis clear-expired
# → {"ok":true,"deleted":5}
```

## Data Fetching Scripts

Scripts handle external API calls so the LLM doesn't burn tokens on data fetching.

### Token Data
```bash
# Scan for new/trending tokens on a specific chain
node scripts/scan-tokens.js --chain <CHAIN> --sort trending --limit 20

# Scan for established conviction-tier tokens (age >7d, volume >$50k)
node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30

# Get detailed token metrics
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check contract safety (uses GoPlus + TokenSniffer)
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check contract changes for all open positions (snapshot diff)
node scripts/check-contract.js --changes

# Check contract changes for a specific token
node scripts/check-contract.js --changes --address <TOKEN_ADDRESS> --chain <CHAIN>
```

### Portfolio Monitoring
```bash
# Get current prices for all positions (reads from DB, respects PAPER_MODE)
node scripts/check-positions.js

# Check liquidity for all open positions (reads from DB, respects PAPER_MODE)
node scripts/check-liquidity.js
node scripts/check-liquidity.js --chain <CHAIN>

# Get portfolio summary (value, allocation, P&L — reads from DB, respects PAPER_MODE)
node scripts/portfolio-summary.js
node scripts/portfolio-summary.js --chain <CHAIN>

# Sync on-chain portfolio — EVM (Safe TX Service primary, DeBank fallback; real mode only)
# Native ETH is stored as gas metadata (not a position). Stablecoins accumulate as cash.
# Output includes gas_balance field with native token balance, price, and value.
node scripts/portfolio-load-evm.js --chain <CHAIN>
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger post_trade
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger manual

# Sync on-chain portfolio — Solana (Helius DAS primary, RPC fallback; real mode only)
# Native SOL is stored as gas metadata (not a position). Stablecoins accumulate as cash.
node scripts/portfolio-load-solana.js --chain solana
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```

### Wallet Tracking (Ad-Hoc)
`check-wallets.js` was the ad-hoc wallet inspector (deleted in P5). The broader smart-money activity feed is now produced by the `activity-wallets-bg` background loop (WalletActivityProcessor NestJS worker) and consumed via `cclaw wallets signals` (see Smart-Money Signals below). Each `fetch` had a 10 s `AbortSignal.timeout` to prevent hanging — now enforced in the NestJS processor.
```bash
# Check all tracked wallets for recent activity (reads from SQLite)
node scripts/check-wallets.js

# Check wallets related to open positions (dev/deployer wallets) — Sentinel heartbeat use
node scripts/check-wallets.js --positions

# Filter to a specific chain
node scripts/check-wallets.js --chain <CHAIN>

# Filter by wallet type
node scripts/check-wallets.js --type smart_money

# Check holder distribution for a token
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check holders AND auto-propose top 5 non-contract holders for wallet scoring
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN> --propose
```

### Wallet Scoring (Smart Money Detection)
```bash
# Score a wallet's trading profitability (0-100)
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN>

# Score and auto-add to tracked wallets if it qualifies
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN> --add

# Score with a custom label
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN> --add --label "Top holder of TOKEN"
```
Uses Birdeye (Solana + EVM) and Zerion (EVM fallback) to analyze wallet PnL.
Classifications: `smart_money` (75+), `whale` (55-74), `trader` (35-54), `retail` (0-34).

### Smart-Money Signals (Background-Produced, DB-Consumed)

The full signal pipeline:

1. **Producer** — `scripts/activity-wallets-bg.js` (background loop in entrypoint.sh, every 30 min).
   - Picks 10 wallets WHERE `type='smart_money' AND status='scored'` ORDER BY `last_checked_at ASC NULLS FIRST` (rotation).
   - Per wallet: fetches recent token transfers (EVM `tokentx`) or parsed transactions (Solana Helius). Per-fetch hard cap 10 s. Per-chain fail-fast at 5 consecutive timeouts.
   - Groups transfers by `tx_hash`; emits one signal per detected swap (one stable/native side + one subject side). Skips airdrops, one-sided transfers, dust.
   - `INSERT OR IGNORE` into `smart_money_signals` (UNIQUE on `tx_hash, wallet_address, action, token_address`).
   - Updates `tracked_wallets.last_checked_at` for every wallet processed (success or failure — rotation always advances).
   - Prunes signals older than 24 h at the start of each cycle.
   - Writes `portfolio_meta.last_activity_wallets_bg_at` after each successful cycle (Observer monitors this for staleness).

2. **Consumers** — read via `cclaw wallets signals`:
   - **Research** (heartbeat, every 30 min): `cclaw wallets signals --since 35m --action buy --group-by token --min-wallets 2` → conviction BUY signals
   - **Sentinel** (heartbeat, every 15 min): `cclaw wallets signals --since 30m --action sell --tokens-in-positions --group-by token` → SELL signals on held tokens (informational, no auto-sell)

Known limitations (accepted):
- Wallets that route trades through multisigs or intent solvers may be miscounted (the swap appears under the router/safe address, not the smart_money wallet).
- Native-only swaps (raw ETH ↔ TOKEN with no WETH wrap) are not detected on EVM — only ERC-20 ↔ ERC-20 (which is what 1inch and most aggregators emit).
- Multi-hop swaps where wallet has multiple OUTs and one IN are skipped (only single-OUT/single-IN matched).

### Market Data
```bash
# Get market overview (BTC dominance, total market cap, fear/greed)
node scripts/market-overview.js

# Classify market regime and get adjusted trading parameters
node scripts/market-regime.js
# → {"status":"ok","regime":"bearish","regimeChanged":true,"adjustments":{"minCashReserve":25,"baseBuyingEnabled":false,...}}
# Regime values: bullish, neutral, bearish, crisis
# Anti-whipsaw: regime only changes after 2 consecutive consistent readings
# Auto-updates portfolio_meta (key: market_regime) and heartbeat timestamp
# Read stored regime: cclaw system meta get --key market_regime

# Check narrative momentum (26 narratives — AI, DeFi, RWA, L2, ZK, memecoins, etc.)
node scripts/narrative-check.js                         # All 26 narratives
node scripts/narrative-check.js --narrative ai_infra    # Single narrative
# → Returns momentum (hot/warming/cooling/cold), volume, top picks, rotation detection
# Narrative IDs: ai_infra, ai_agents, defi, restaking, lst, yield, payfi, rwa, prediction,
#   l2, zk, modular, intents, depin, memecoin, socialfi, gaming, nft_infra, btc_eco, btc_l2,
#   privacy, telegram, consumer, desci, degov, energy

# Deep narrative scan — find and rank top tokens within a narrative
node scripts/narrative-deep-scan.js --narrative ai_infra                  # Manual: all keywords, top 10
node scripts/narrative-deep-scan.js --narrative all                       # All 26 narratives
node scripts/narrative-deep-scan.js --narrative all --hot-only            # Only hot/warming narratives
node scripts/narrative-deep-scan.js --narrative ai_infra --quick          # Agent mode: 1 keyword, top 3
node scripts/narrative-deep-scan.js --narrative all --hot-only --quick    # Agent heartbeat use
node scripts/narrative-deep-scan.js --narrative ai_infra --chain <CHAIN> --limit 5
# → Returns ranked tokens with score, suggested tier, volume, liquidity, buy ratio
```

### Heartbeat Pre-Check
```bash
# Check if executor has pending work (used by background loop)
node scripts/heartbeat-check.js --agent executor
# → {"agent":"executor","skip":true,"reason":"no pending orders"}
# → {"agent":"executor","skip":false,"pending_sells":2,"pending_buys":1}

# Check if sentinel has open positions to monitor (used by background loop)
node scripts/heartbeat-check.js --agent sentinel
# → {"agent":"sentinel","skip":true,"reason":"no open positions"}
# → {"agent":"sentinel","skip":false,"open_positions":3}
```

### Multisig Transaction Tracker (Background — No LLM)
```bash
# Monitors queued Safe/Squads transactions — runs every 5 min in real mode
node scripts/track-multisig.js
# → {"checked":2,"confirmed":1,"pending":1,"failed":0}
```
Tracks draft positions (BUY queued in multisig) and pending_exit positions (SELL queued in multisig).
When a transaction is confirmed on-chain: receipt updated to `executed`, position activated (`draft` → `open`) or closed (`pending_exit` → `closed`), portfolio synced.
When rejected: receipt set to `reverted`, draft positions deleted (cash refunded), pending_exit reverted to `open`.
Sends reminder alerts every 30 minutes for pending transactions.

#### Position Statuses
| Status | Meaning |
|--------|---------|
| `open` | Active, monitored by Sentinel |
| `draft` | BUY queued in multisig — committed but not yet confirmed on-chain |
| `pending_exit` | SELL queued in multisig — awaiting confirmation |
| `partial_exit` | Partial sell executed |
| `closed` | Fully exited |
| `pending_analysis` | Discovered on-chain, awaiting analysis |

## Trade Execution (Real Mode Only)

### Execute Trade via Safe Wallet

Requires `SAFE_ADDRESS_<CHAIN>`, `RPC_<CHAIN>`, and chain-specific explorer API key.

```bash
# BUY: spend USDC to buy a token
node scripts/execute-trade-evm.js \
  --action buy --chain <CHAIN> --address 0xTOKEN --symbol TOKEN \
  --amount 500 --max-slippage 5 --tier moonshot --deadline 300

# SELL: sell all tokens back to USDC
node scripts/execute-trade-evm.js \
  --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN \
  --amount all --max-slippage 5

# SELL: sell specific quantity
node scripts/execute-trade-evm.js \
  --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN \
  --amount 10000 --max-slippage 2 --deadline 300
```

**Output statuses:**
- `executed` — transaction confirmed on-chain (includes `txHash`)
- `queued_in_safe` — proposed to Safe, needs more signatures (includes `safeHash`)
- `failed` — with error message

The script handles: 1inch swap quoting, ERC-20 approvals, Safe multi-send transaction building, signing with `SAFE_SIGNER_KEY`, and proposing/executing via Safe Transaction Service.

### Execute Trade via Squads Multisig (Solana)
```bash
# BUY: spend USDC to buy a token via Jupiter + Squads
node scripts/execute-trade-solana.js \
  --action buy --chain solana --address <MINT_ADDRESS> --symbol TOKEN \
  --amount 500 --max-slippage 5 --tier moonshot

# SELL: sell all tokens back to USDC via Jupiter + Squads
node scripts/execute-trade-solana.js \
  --action sell --chain solana --address <MINT_ADDRESS> --symbol TOKEN \
  --amount all --max-slippage 5
```

**Output statuses:**
- `executed` — transaction confirmed on-chain (includes `txSignature`)
- `queued_in_squads` — proposed and approved, needs more squad member approvals (includes `squadsTransactionIndex`)
- `failed` — with error message

The script handles: Jupiter swap quoting, Squads vault transaction creation, proposal, approval, and execution (if threshold met). Signs with `SQUADS_SIGNER_KEY`.

**Requires:** `SQUADS_VAULT_ADDRESS` (or `SQUADS_MULTISIG_ADDRESS`), `SQUADS_SIGNER_KEY`, `RPC_SOL` env vars.

### Check Safe Wallet Status (EVM)
```bash
# Get Safe info: nonce, threshold, owners, balances, pending txs
node scripts/check-safe-status.js --chain <CHAIN>

# Check a specific pending transaction
node scripts/check-safe-status.js --chain <CHAIN> --safe-hash 0xABC123...
```

**Requires:** `SAFE_ADDRESS_<CHAIN>`, `RPC_<CHAIN>` env vars.

### Check Squads Multisig Status (Solana)
```bash
# Get Squads info: threshold, members, vault balances
node scripts/check-squads-status.js

# Include pending transaction details
node scripts/check-squads-status.js --pending
```

**Requires:** `SQUADS_VAULT_ADDRESS` (or `SQUADS_MULTISIG_ADDRESS`), `RPC_SOL` env vars.

## Emergency Scripts (No LLM Required)

These scripts run automatically when all model providers fail. They provide deterministic position protection without needing any LLM.

### Emergency Sentinel
```bash
# Script-only position monitor — runs when sentinel agent can't reach any model
# Checks: stop-loss, take-profit, severe loss (>30%), liquidity drain (>50% drop), low liquidity (<$5k)
# Writes sell orders to the orders table, logs to sentinel_log
node scripts/emergency-sentinel.js
```

### Emergency Executor
```bash
# Script-only sell executor — runs when executor agent can't reach any model
# Processes SELL orders only (never buys). Calls execute-trade-evm.js / execute-trade-solana.js
# In paper mode: simulates execution, writes to paper tables
node scripts/emergency-executor.js
```

### Send Alert (cclaw alerts send — ADR-0028)
```bash
# Fire-and-forget Telegram notification via cclaw alerts send
# Routes to correct Telegram supergroup topic based on alert type:
#   trade_proposal → Research topic    | sell_triggered → Sentinel topic
#   trade_executed/failed → Executor   | model_failure/emergency_mode/rug_warning → Alerts
#   recovered/heartbeat_summary → System | portfolio_daily/rebalance_event → Portfolio
cclaw alerts send --type model_failure --agent sentinel --message "Agent failed"
cclaw alerts send --type emergency_mode --agent executor --message "Emergency mode active"
cclaw alerts send --type recovered --agent sentinel --message "Back to normal"
cclaw alerts send --type trade_proposal --agent research --message "BUY proposal: TOKEN"
cclaw alerts send --type heartbeat_summary --agent executor --message "Cycle OK"
cclaw alerts send --type portfolio_daily --agent system --message "Daily P&L report"
```

### Telegram Approval Buttons
[`send-approval.js` deleted in P5. Approval buttons are now sent automatically by `ApprovalBotService` (NestJS worker, ADR-0027) when an order is set to `pending` status — no agent action required. Human approves or rejects via Telegram buttons or chat (orders skill).]

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | (env var) | Comma-separated list of active chains. Controls which chains are scanned and synced. Run `cclaw system chains` for current list. |
| `PAPER_MODE` | `false` | Enable simulated trading (no real transactions, no on-chain sync) |
| `AUTO_APPROVE_BUY` | `false` | Auto-approve BUY orders without human confirmation (real mode only, `approved_by: 'auto'`) |

## API Keys Required (set in environment)

| Variable | Service | Used For |
|----------|---------|----------|
| `DEBANK_API_KEY` | DeBank Cloud | On-chain portfolio sync (EVM chains) |
| `GOPLUS_API_KEY` | GoPlus | Contract security scanning |
| `ETHERSCAN_API_KEY` | Etherscan | Ethereum wallet tracking + contract verification (also used for Ethereum chain) |
| `BASESCAN_API_KEY` | Basescan | Base L2 wallet tracking |
| `BIRDEYE_API_KEY` | Birdeye | Wallet PnL scoring (Solana + EVM) + token data |
| `ZERION_API_KEY` | Zerion | Wallet PnL scoring (EVM fallback, free 3k/day) |
| `SOLSCAN_API_KEY` | Solscan | Solana wallet tracking + contract data |
| `HELIUS_API_KEY` | Helius | Solana wallet tracking (fallback if no Solscan) |

DEXScreener and CoinGecko free tiers don't require API keys.

## Codex OAuth Login (codex-login.sh)

One-time authentication for OpenAI Codex OAuth provider (ChatGPT subscription — flat fee).

```bash
# Run inside Docker container
bash /home/openclaw/crypto-claw/scripts/codex-login.sh
# Or directly:
openclaw models auth login --provider openai-codex
```

- Uses OpenClaw's native `openai-codex` provider with built-in OAuth
- Auth managed and refreshed automatically by OpenClaw
- After login, restart the container to activate
- If Codex OAuth is not set up, falls back to `OPENAI_API_KEY` (per-token billing)

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- db-query.js outputs JSON to stdout, errors to stderr with exit 1
- If a script fails, log the error and try an alternative data source
- Rate limits: most APIs allow 5-10 req/sec — scripts handle throttling internally
- NEVER pass wallet private keys to any script — scripts only READ external data
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query
