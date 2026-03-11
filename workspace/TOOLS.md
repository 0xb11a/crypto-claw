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
# Get full portfolio summary (cash + positions + value)
node scripts/db-query.js get-portfolio

# Get/set cash balance
node scripts/db-query.js get-cash
node scripts/db-query.js set-cash --amount 5000

# Get/set arbitrary metadata
node scripts/db-query.js get-meta --key my_key
node scripts/db-query.js set-meta --key my_key --value my_value
```

### Positions
```bash
# List positions (optionally filter by status)
node scripts/db-query.js get-positions
node scripts/db-query.js get-positions --status open

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
node scripts/db-query.js update-position --id pos-001 --json '{"status":"closed","exit_price":0.002}'
```

### Approved Trades (Research → Executor)
```bash
# Get pending approved trades
node scripts/db-query.js get-approved-trades

# Write an approved trade (after human says yes)
node scripts/db-query.js add-approved-trade --json '{
  "id": "trade-001",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "buy",
  "amount": 500,
  "tier": "moonshot",
  "entry_price": 0.001,
  "stop_loss": 0.0005,
  "take_profit_levels": "[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]",
  "approved": true,
  "reasoning": "Strong AI narrative play"
}'

# Mark as executed by Executor
node scripts/db-query.js mark-trade-executed --id trade-001
```

### Sell Orders (Sentinel → Executor)
```bash
# Get pending sell orders
node scripts/db-query.js get-sell-orders

# Write a sell order
node scripts/db-query.js add-sell-order --json '{
  "id": "sell-001",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "amount": "all",
  "reason": "stop_loss",
  "urgency": "immediate"
}'

# Mark as executed
node scripts/db-query.js mark-sell-executed --id sell-001
```

### Trade Receipts (Executor → All)
```bash
# Get recent receipts
node scripts/db-query.js get-receipts --limit 10

# Write a receipt after execution
node scripts/db-query.js add-receipt --json '{
  "id": "rcpt-001",
  "order_id": "trade-001",
  "order_source": "approved_trades",
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
The background scorer (`score-wallets-bg.js`) runs every 10 minutes and processes up to 5 wallets per cycle. It respects API rate limits (6s between wallets). Wallets that fail scoring are retried up to 3 times.

### Heartbeat & Logs
```bash
# Check when agents last ran
node scripts/db-query.js get-heartbeat

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

# Get/set paper cash balance
node scripts/db-query.js get-paper-cash
node scripts/db-query.js set-paper-cash --amount 10000

# Paper positions
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --status closed

# Add a paper position (auto-deducts value_usd from paper_cash)
node scripts/db-query.js add-paper-position --json '{
  "id": "pp-001",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "entry_price": 0.001,
  "quantity": 10000,
  "stop_loss": 0.0005,
  "take_profit_levels": [{"level":1,"price":0.002,"sellPercent":50}]
}'

# Update paper position
node scripts/db-query.js update-paper-position --id pp-001 --json '{"current_price": 0.0015, "value_usd": 15}'

# Close paper position (auto-calculates P&L, auto-adds sale proceeds to paper_cash)
node scripts/db-query.js close-paper-position --id pp-001 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'

# Record a paper trade
node scripts/db-query.js add-paper-trade --json '{
  "id": "pt-001",
  "order_id": "trade-001",
  "order_source": "approved_trades",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "proposed_price": 0.001,
  "quantity": 10000,
  "amount": 500
}'

# Get paper trades
node scripts/db-query.js get-paper-trades
node scripts/db-query.js get-paper-trades --limit 10

# Get paper trading statistics (win rate, P&L, return)
node scripts/db-query.js get-paper-stats
```

## Data Fetching Scripts

Scripts handle external API calls so the LLM doesn't burn tokens on data fetching.

### Token Data
```bash
# Scan for new/trending tokens on a specific chain
node scripts/scan-tokens.js --chain solana --sort trending --limit 20

# Get detailed token metrics
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check contract safety (uses GoPlus + TokenSniffer)
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN>
```

### Portfolio Monitoring
```bash
# Get current prices for all positions
node scripts/check-positions.js

# Check liquidity for all open positions
node scripts/check-liquidity.js

# Get portfolio summary (value, allocation, P&L)
node scripts/portfolio-summary.js
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

# Check narrative momentum (aggregates social + price data)
node scripts/narrative-check.js --narrative <ai|rwa|depin|memecoin|gaming>
```

## API Keys Required (set in environment)

| Variable | Service | Used For |
|----------|---------|----------|
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
