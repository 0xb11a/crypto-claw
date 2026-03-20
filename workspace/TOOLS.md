# TOOLS.md — CryptoClaw Tool Usage Guide

## General Notes
- All scripts output **valid JSON to stdout**. You can read the output directly — no need to pipe through `jq` unless you want to extract a specific field.
- `jq` is available in the container if needed (e.g., `node scripts/scan-tokens.js | jq '.tokens[0].symbol'`).
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below — they call the APIs directly.

## Database CLI (db-query.js)

All wallet data (positions, trades, orders, alerts, receipts) lives in a SQLite database. Interact with it through `db-query.js` — never access the DB file directly.

### Portfolio & Cash
```bash
# Get full portfolio summary (all chains)
node scripts/db-query.js get-portfolio

# Get per-chain portfolio (chain-specific cash + positions + value)
node scripts/db-query.js get-portfolio --chain base
node scripts/db-query.js get-portfolio --chain solana

# Get cash balance (all chains breakdown)
node scripts/db-query.js get-cash
# Get per-chain cash
node scripts/db-query.js get-cash --chain base

# Set cash balance (requires --chain)
node scripts/db-query.js set-cash --chain base --amount 5000

# Get/set arbitrary metadata
node scripts/db-query.js get-meta --key my_key
node scripts/db-query.js set-meta --key my_key --value my_value
```

### Positions
```bash
# List positions (optionally filter by status and/or symbol)
node scripts/db-query.js get-positions
node scripts/db-query.js get-positions --status open
node scripts/db-query.js get-positions --symbol TOKEN

# Add a new position
node scripts/db-query.js add-position --json '{
  "id": "pos-001",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "entry_price": 0.001,
  "quantity": 10000,
  "stop_loss": 0.0005,
  "take_profit_levels": [{"level":1,"price":0.002,"sellPercent":50}]
}'

# Update position fields
node scripts/db-query.js update-position --id pos-001 --json '{"current_price": 0.0015}'

# Close position — full exit (auto-calculates P&L)
node scripts/db-query.js close-position --id pos-001 --json '{"exit_price": 0.002, "exit_reason": "stop_loss"}'

# Close position — partial exit (reduces quantity, tracks cumulative P&L)
node scripts/db-query.js close-position --id pos-001 --quantity 5000 --json '{"exit_price": 0.002, "exit_reason": "take_profit_partial"}'
```

### Orders (Research/Sentinel → Executor)
```bash
# Get all orders (newest first)
node scripts/db-query.js get-orders

# Get pending orders (executor queue — oldest first)
node scripts/db-query.js get-orders --pending

# Get pending buy orders only
node scripts/db-query.js get-orders --pending --action buy

# Get pending sell orders only
node scripts/db-query.js get-orders --pending --action sell

# Write a buy order (after human approval or paper auto-approve)
node scripts/db-query.js add-order --json '{
  "id": "trade-001",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "amount": 500,
  "tier": "moonshot",
  "entry_price": 0.001,
  "stop_loss": 0.0005,
  "take_profit_levels": "[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]",
  "approved": true,
  "reasoning": "Strong AI narrative play"
}'

# Write a sell order (auto-approved by sentinel)
node scripts/db-query.js add-order --json '{
  "id": "sell-001",
  "action": "sell",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "amount": "all",
  "reason": "stop_loss",
  "urgency": "immediate"
}'

# Mark order as executed by Executor
node scripts/db-query.js mark-order-executed --id trade-001
```

### Receipts (Executor → All)
```bash
# Get recent receipts
node scripts/db-query.js get-receipts --limit 10

# Write a receipt after execution
node scripts/db-query.js add-receipt --json '{
  "id": "rcpt-001",
  "order_id": "trade-001",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "status": "executed",
  "safe_tx_hash": "0x...",
  "onchain_tx_hash": "0x...",
  "executed_price": 0.00098,
  "slippage": 0.02
}'
```

### Sentinel Alerts (Sentinel → Research)
```bash
# Get unprocessed alerts
node scripts/db-query.js get-alerts --unprocessed

# Write an alert
node scripts/db-query.js add-alert --json '{
  "id": "alert-001",
  "symbol": "TOKEN",
  "chain": "base",
  "alert_type": "liquidity_drop",
  "severity": "high",
  "details": "Liquidity dropped 25% in 5 minutes"
}'

# Mark alert as processed
node scripts/db-query.js mark-alert-processed --id alert-001
```

### Watchlist
```bash
# Get current watchlist
node scripts/db-query.js get-watchlist

# Add token to watchlist
node scripts/db-query.js add-to-watchlist --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "reason": "Smart money accumulation",
  "target_entry": 0.001
}'
```

### Liquidity Snapshots
```bash
# Get latest liquidity for an address
node scripts/db-query.js get-liquidity --address 0x... --chain base

# Save new snapshot
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain base --liquidity 50000
```

### Contract Snapshots
```bash
# Get latest contract safety snapshots for an address
node scripts/db-query.js get-contract-snapshots --address 0x... --chain base
node scripts/db-query.js get-contract-snapshots --address 0x... --chain base --limit 10

# Save new contract safety snapshot
node scripts/db-query.js add-contract-snapshot --address 0x... --chain base --json '<safety_data_json>'
```

### Wallet Tracking
```bash
# Get tracked wallets (all)
node scripts/db-query.js get-tracked-wallets

# Get tracked wallets by status (proposed, scoring, scored, failed)
node scripts/db-query.js get-tracked-wallets --status scored

# Add a wallet (type: smart_money, dev, whale, deployer, trader, retail)
# If type is set, defaults to status='scored'; if null, status='proposed'
node scripts/db-query.js add-tracked-wallet --json '{
  "address": "0x...",
  "chain": "base",
  "label": "Smart Money #3",
  "type": "smart_money"
}'

# Add a deployer wallet (link to token via notes)
node scripts/db-query.js add-tracked-wallet --json '{
  "address": "0x...",
  "chain": "ethereum",
  "label": "TOKEN deployer",
  "type": "deployer",
  "notes": "Deployer for TOKEN (0xTokenAddress)"
}'

# Remove a tracked wallet
node scripts/db-query.js remove-tracked-wallet --address 0x... --chain base
```

### Wallet Scoring Pipeline
```bash
# Propose a wallet for background scoring (fast, no API calls)
node scripts/db-query.js propose-wallet --json '{
  "address": "0x...",
  "chain": "base",
  "label": "Top holder #3 of TOKEN",
  "source_token": "0xTokenAddr"
}'

# Get wallets waiting to be scored (proposed + failed with retry < 3)
node scripts/db-query.js get-unscored-wallets
node scripts/db-query.js get-unscored-wallets --limit 10

# Update a wallet's score (used by background scorer)
node scripts/db-query.js update-wallet-score --address 0x... --chain base --json '{
  "score": 78,
  "type": "smart_money",
  "score_breakdown": {"profitability":85,"reputation":70,"volume":80,"activity":75,"consistency":60},
  "status": "scored"
}'
```
The background scorer (`score-wallets-bg.js`) runs every 10 minutes and processes up to 10 wallets per cycle (3s between wallets). Each scoring call auto-harvests ~100 wallets from Birdeye leaderboard + ~50 from token top traders into `tracked_wallets` (snowball effect). Wallets that fail scoring are retried up to 3 times.

The `source` column tracks how a wallet was discovered: `agent` (manually proposed), `leaderboard` (Birdeye top gainers), `token_traders` (Birdeye token top traders), `holder_extraction` (from holder-distribution.js `--propose`).

### Heartbeat & Logs
```bash
# Check when agents last ran
node scripts/db-query.js get-heartbeat --agent <agent_name>

# Update heartbeat timestamp
node scripts/db-query.js update-heartbeat --agent research --check token_scan

# Write agent logs
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"status":"ok"}'
node scripts/db-query.js add-executor-log --json '{"action":"process_orders","sells_processed":1,"buys_processed":0,"status":"ok"}'

# Trade statistics
node scripts/db-query.js get-trade-stats
```

### Paper Mode (Simulated Trading)
```bash
# Get paper portfolio (cash, P&L, open positions, closed history, recent trades)
node scripts/db-query.js get-paper-portfolio

# Get paper cash balance (all chains breakdown)
node scripts/db-query.js get-paper-cash
# Get per-chain paper cash
node scripts/db-query.js get-paper-cash --chain base

# Set paper cash balance (requires --chain)
node scripts/db-query.js set-paper-cash --chain base --amount 10000

# Paper positions
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --status closed
node scripts/db-query.js get-paper-positions --symbol TOKEN

# Add a paper position (auto-deducts value_usd from paper_cash, auto-calculates quantity)
node scripts/db-query.js add-paper-position --json '{
  "id": "pp-001",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "entry_price": 0.001,
  "value_usd": 10,
  "stop_loss": 0.0005,
  "take_profit_levels": [{"level":1,"price":0.002,"sellPercent":50}]
}'

# Update paper position
node scripts/db-query.js update-paper-position --id pp-001 --json '{"current_price": 0.0015, "value_usd": 15}'

# Close paper position (auto-calculates P&L, auto-adds sale proceeds to paper_cash)
node scripts/db-query.js close-paper-position --id pp-001 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'

# Record a paper receipt
node scripts/db-query.js add-paper-receipt --json '{
  "id": "pt-001",
  "order_id": "trade-001",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "proposed_price": 0.001,
  "quantity": 10000,
  "amount": 500
}'

# Get paper receipts
node scripts/db-query.js get-paper-receipts
node scripts/db-query.js get-paper-receipts --limit 10

# Get paper trading statistics (win rate, P&L, return)
node scripts/db-query.js get-paper-stats
```

### Portfolio Sync (On-Chain — Real Mode Only)
```bash
# Trigger on-chain portfolio sync for a chain (routes to correct loader based on chain type)
node scripts/db-query.js sync-portfolio --chain base
node scripts/db-query.js sync-portfolio --chain base --trigger post_trade

# Get last sync status (per chain)
node scripts/db-query.js get-sync-status
node scripts/db-query.js get-sync-status --chain base

# Update a position's on-chain balance (used by sync scripts)
node scripts/db-query.js set-onchain-balance --id <position_id> --balance 1000.5
```
In paper mode, `sync-portfolio` returns a message explaining sync is skipped (DB is sole source of truth).

### Analysis Cache (Token Dedup)
```bash
# Check if a token needs analysis (dedup before spawning sub-agents)
# Returns action: "skip" or "analyze" with reason
node scripts/db-query.js check-token-status --address 0x... --chain base
# → {"address":"0x...","chain":"base","action":"skip","reason":"open_position","details":{...}}
# → {"address":"0x...","chain":"base","action":"analyze","reason":"none"}
# Checks in order: open positions, pending buys, pending sells, watchlist, cached analysis

# Cache an avoid/reject verdict (prevents re-analysis for 24h by default)
node scripts/db-query.js cache-analysis --json '{
  "address": "0x...",
  "chain": "base",
  "symbol": "TOKEN",
  "analysis_score": 25,
  "verdict": "avoid",
  "reasoning": "Low liquidity, unverified contract"
}'

# Cache with custom TTL (e.g., 12 hours)
node scripts/db-query.js cache-analysis --json '{
  "address": "0x...",
  "chain": "base",
  "verdict": "risk_rejected",
  "risk_score": 82,
  "reasoning": "Top holder >30%",
  "ttl_hours": 12
}'

# List all unexpired cache entries (debugging)
node scripts/db-query.js get-analysis-cache

# Delete expired cache entries (run during daily summary)
node scripts/db-query.js clear-expired-cache
# → {"ok":true,"deleted":5}
```

## Data Fetching Scripts

Scripts handle external API calls so the LLM doesn't burn tokens on data fetching.

### Token Data
```bash
# Scan for new/trending tokens on a specific chain
node scripts/scan-tokens.js --chain solana --sort trending --limit 20

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
node scripts/check-liquidity.js --chain base
node scripts/check-liquidity.js --chain solana

# Get portfolio summary (value, allocation, P&L — reads from DB, respects PAPER_MODE)
node scripts/portfolio-summary.js
node scripts/portfolio-summary.js --chain base
node scripts/portfolio-summary.js --chain solana

# Sync on-chain portfolio — EVM (Safe TX Service primary, DeBank fallback; real mode only)
node scripts/portfolio-load-evm.js --chain base
node scripts/portfolio-load-evm.js --chain base --trigger post_trade
node scripts/portfolio-load-evm.js --chain base --trigger manual

# Sync on-chain portfolio — Solana (Helius DAS primary, RPC fallback; real mode only)
node scripts/portfolio-load-solana.js --chain solana
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```

### Wallet Tracking
```bash
# Check all tracked wallets for recent activity (reads from SQLite)
node scripts/check-wallets.js

# Check wallets related to open positions (dev/deployer wallets)
node scripts/check-wallets.js --positions

# Filter to a specific chain
node scripts/check-wallets.js --chain base

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
# Read stored regime: node scripts/db-query.js get-meta --key market_regime

# Check narrative momentum (aggregates social + price data)
node scripts/narrative-check.js --narrative <ai|rwa|depin|memecoin|gaming>
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

## Trade Execution (Real Mode Only)

### Execute Trade via Safe Wallet
```bash
# BUY: spend USDC to buy a token
node scripts/execute-trade.js \
  --action buy --chain base --address 0xTOKEN --symbol TOKEN \
  --amount 500 --max-slippage 5 --tier moonshot --deadline 300

# SELL: sell all tokens back to USDC
node scripts/execute-trade.js \
  --action sell --chain base --address 0xTOKEN --symbol TOKEN \
  --amount all --max-slippage 5

# SELL: sell specific quantity
node scripts/execute-trade.js \
  --action sell --chain base --address 0xTOKEN --symbol TOKEN \
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
node scripts/check-safe-status.js --chain base

# Check a specific pending transaction
node scripts/check-safe-status.js --chain base --safe-hash 0xABC123...
```

**Requires:** `SAFE_ADDRESS_BASE`, `RPC_BASE` env vars.

### Check Squads Multisig Status (Solana)
```bash
# Get Squads info: threshold, members, vault balances
node scripts/check-squads-status.js

# Include pending transaction details
node scripts/check-squads-status.js --pending
```

**Requires:** `SQUADS_VAULT_ADDRESS` (or `SQUADS_MULTISIG_ADDRESS`), `RPC_SOL` env vars.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | `base` | Comma-separated list of active chains. Controls which chains are scanned and synced. Supported: `base`, `solana`. |
| `PAPER_MODE` | `false` | Enable simulated trading (no real transactions, no on-chain sync) |

## API Keys Required (set in environment)

| Variable | Service | Used For |
|----------|---------|----------|
| `DEBANK_API_KEY` | DeBank Cloud | On-chain portfolio sync (EVM chains) |
| `GOPLUS_API_KEY` | GoPlus | Contract security scanning |
| `ETHERSCAN_API_KEY` | Etherscan | Ethereum wallet tracking + contract verification |
| `BASESCAN_API_KEY` | Basescan | Base L2 wallet tracking |
| `ARBISCAN_API_KEY` | Arbiscan | Arbitrum L2 wallet tracking |
| `OPTIMISM_API_KEY` | OP Etherscan | Optimism L2 wallet tracking |
| `BIRDEYE_API_KEY` | Birdeye | Wallet PnL scoring (Solana + EVM) + token data |
| `ZERION_API_KEY` | Zerion | Wallet PnL scoring (EVM fallback, free 3k/day) |
| `SOLSCAN_API_KEY` | Solscan | Solana wallet tracking + contract data |
| `HELIUS_API_KEY` | Helius | Solana wallet tracking (fallback if no Solscan) |

DEXScreener and CoinGecko free tiers don't require API keys.

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- db-query.js outputs JSON to stdout, errors to stderr with exit 1
- If a script fails, log the error and try an alternative data source
- Rate limits: most APIs allow 5-10 req/sec — scripts handle throttling internally
- NEVER pass wallet private keys to any script — scripts only READ external data
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query
