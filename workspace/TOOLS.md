# TOOLS.md — CryptoClaw Tool Usage Guide

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
# Get tracked wallets
node scripts/db-query.js get-tracked-wallets

# Add a wallet
node scripts/db-query.js add-tracked-wallet --json '{
  "address": "0x...",
  "chain": "base",
  "label": "Smart Money #3",
  "category": "smart_money"
}'
```

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
# Get paper portfolio (positions + cash + value)
node scripts/db-query.js get-paper-portfolio

# Get/set paper cash balance
node scripts/db-query.js get-paper-cash
node scripts/db-query.js set-paper-cash --amount 10000

# Paper positions
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --status closed

# Add a paper position
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

# Close paper position (auto-calculates P&L)
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
# Check tracked smart money wallets for new activity
node scripts/check-wallets.js

# Check with position context
node scripts/check-wallets.js --positions

# Check holder distribution for a token
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN>
```

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
| `ETHERSCAN_API_KEY` | Etherscan | EVM contract verification, wallet tracking |
| `BIRDEYE_API_KEY` | Birdeye | Solana token data (optional) |
| `SOLSCAN_API_KEY` | Solscan | Solana contract data (optional) |

DEXScreener and CoinGecko free tiers don't require API keys.

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- db-query.js outputs JSON to stdout, errors to stderr with exit 1
- If a script fails, log the error and try an alternative data source
- Rate limits: most APIs allow 5-10 req/sec — scripts handle throttling internally
- NEVER pass wallet private keys to any script — scripts only READ external data
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query
