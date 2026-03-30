# TOOLS.md — Research Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. You can read the output directly — no need to pipe through `jq` unless you want to extract a specific field.
- `jq` is available in the container if needed (e.g., `node scripts/scan-tokens.js | jq '.tokens[0].symbol'`).
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below — they call the APIs directly.

## Database CLI (db-query.js)

All wallet data (positions, trades, orders, alerts, receipts) lives in a SQLite database. Interact with it through `db-query.js` — never access the DB file directly.

### Portfolio & Cash
```bash
node scripts/db-query.js get-portfolio
node scripts/db-query.js get-portfolio --chain base
node scripts/db-query.js get-portfolio --chain ethereum
node scripts/db-query.js get-cash
node scripts/db-query.js get-cash --chain base
node scripts/db-query.js get-cash --chain ethereum
node scripts/db-query.js set-cash --chain base --amount 5000
node scripts/db-query.js set-cash --chain ethereum --amount 5000
node scripts/db-query.js get-gas
node scripts/db-query.js get-gas --chain base
node scripts/db-query.js get-gas --chain ethereum
node scripts/db-query.js get-meta --key my_key
node scripts/db-query.js set-meta --key my_key --value my_value
```

### Positions
```bash
node scripts/db-query.js get-positions
node scripts/db-query.js get-positions --status open
node scripts/db-query.js get-positions --symbol TOKEN
node scripts/db-query.js add-position --json '{"id":"pos-001","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","entry_price":0.001,"quantity":10000,"stop_loss":0.0005,"take_profit_levels":[{"level":1,"price":0.002,"sellPercent":50}]}'
# For Ethereum, use "chain":"ethereum"
node scripts/db-query.js update-position --id pos-001 --json '{"current_price": 0.0015}'
# Close position — full exit (auto-calculates P&L)
node scripts/db-query.js close-position --id pos-001 --json '{"exit_price": 0.002, "exit_reason": "stop_loss"}'
# Close position — partial exit (reduces quantity, tracks cumulative P&L)
node scripts/db-query.js close-position --id pos-001 --quantity 5000 --json '{"exit_price": 0.002, "exit_reason": "take_profit_partial"}'
```

### Orders (Research → Executor)

Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).

```bash
node scripts/db-query.js get-orders
node scripts/db-query.js get-orders --pending
node scripts/db-query.js get-orders --status approved --action buy
node scripts/db-query.js get-orders --status approved --action sell
node scripts/db-query.js get-order --id trade-001
node scripts/db-query.js get-order-history --limit 20
node scripts/db-query.js get-order-history --status rejected

# Write a buy order (status: pending in real mode, approved in paper mode)
node scripts/db-query.js add-order --json '{"id":"trade-001","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","amount":500,"tier":"moonshot","entry_price":0.001,"stop_loss":0.0005,"take_profit_levels":"[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]","reasoning":"Strong AI narrative play"}'
# For Ethereum, use "chain":"ethereum"

# Write a sell order (auto-approved by sentinel)
node scripts/db-query.js add-order --json '{"id":"sell-001","action":"sell","symbol":"TOKEN","address":"0x...","chain":"base","amount":"all","reason":"stop_loss_hit","urgency":"immediate"}'
# For Ethereum, use "chain":"ethereum"

node scripts/db-query.js approve-order --id trade-001 --by human
node scripts/db-query.js reject-order --id trade-001 --reason "low liquidity" --by human
node scripts/db-query.js cancel-order --id trade-001 --reason "market changed" --by human
# Retry a failed sell order (re-queue for execution; buys cannot be retried)
node scripts/db-query.js retry-order --id sell-001 --by human
node scripts/db-query.js mark-order-executed --id trade-001
node scripts/db-query.js mark-order-executed --id trade-001 --status failed --reason "tx_failed"
```

### Receipts
```bash
node scripts/db-query.js get-receipts --limit 10
node scripts/db-query.js add-receipt --json '{"id":"rcpt-001","order_id":"trade-001","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","status":"executed","safe_tx_hash":"0x...","onchain_tx_hash":"0x...","executed_price":0.00098,"slippage":0.02}'
# For Ethereum, use "chain":"ethereum"
```

### Sentinel Alerts
```bash
node scripts/db-query.js get-alerts --unprocessed
node scripts/db-query.js add-alert --json '{"id":"alert-001","symbol":"TOKEN","chain":"base","alert_type":"liquidity_drop","severity":"high","details":"Liquidity dropped 25% in 5 minutes"}'
# For Ethereum, use "chain":"ethereum"
node scripts/db-query.js mark-alert-processed --id alert-001
```

### Watchlist
```bash
node scripts/db-query.js get-watchlist
node scripts/db-query.js add-to-watchlist --json '{"symbol":"TOKEN","address":"0x...","chain":"base","reason":"Smart money accumulation","target_entry":0.001}'
# For Ethereum, use "chain":"ethereum"
```

### Liquidity Snapshots
```bash
node scripts/db-query.js get-liquidity --address 0x... --chain base
node scripts/db-query.js get-liquidity --address 0x... --chain ethereum
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain base --liquidity 50000
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain ethereum --liquidity 50000
```

### Contract Snapshots
```bash
node scripts/db-query.js get-contract-snapshots --address 0x... --chain base
node scripts/db-query.js get-contract-snapshots --address 0x... --chain ethereum
node scripts/db-query.js get-contract-snapshots --address 0x... --chain base --limit 10
node scripts/db-query.js add-contract-snapshot --address 0x... --chain base --json '<safety_data_json>'
node scripts/db-query.js add-contract-snapshot --address 0x... --chain ethereum --json '<safety_data_json>'
```

### Wallet Tracking
```bash
node scripts/db-query.js get-tracked-wallets
node scripts/db-query.js get-tracked-wallets --status scored
# type: smart_money, dev, whale, deployer, trader, retail. If type set → status='scored'; if null → status='proposed'
node scripts/db-query.js add-tracked-wallet --json '{"address":"0x...","chain":"base","label":"Smart Money #3","type":"smart_money"}'
node scripts/db-query.js add-tracked-wallet --json '{"address":"0x...","chain":"ethereum","label":"TOKEN deployer","type":"deployer","notes":"Deployer for TOKEN (0xTokenAddress)"}'
node scripts/db-query.js remove-tracked-wallet --address 0x... --chain base
node scripts/db-query.js remove-tracked-wallet --address 0x... --chain ethereum
```

### Wallet Scoring Pipeline
```bash
# Propose a wallet for background scoring (fast, no API calls)
node scripts/db-query.js propose-wallet --json '{"address":"0x...","chain":"base","label":"Top holder #3 of TOKEN","source_token":"0xTokenAddr"}'
# For Ethereum, use "chain":"ethereum"
node scripts/db-query.js get-unscored-wallets
node scripts/db-query.js get-unscored-wallets --limit 10
node scripts/db-query.js update-wallet-score --address 0x... --chain base --json '{"score":78,"type":"smart_money","score_breakdown":{"profitability":85,"reputation":70,"volume":80,"activity":75,"consistency":60},"status":"scored"}'
node scripts/db-query.js update-wallet-score --address 0x... --chain ethereum --json '{"score":78,"type":"smart_money","score_breakdown":{"profitability":85,"reputation":70,"volume":80,"activity":75,"consistency":60},"status":"scored"}'
```
Background scorer (`score-wallets-bg.js`) runs every 10 min, processes up to 10 wallets/cycle. Auto-harvests wallets from Birdeye leaderboard + token top traders. Failed wallets retry up to 3 times.
Source values: `agent`, `leaderboard`, `token_traders`, `holder_extraction`.

### Heartbeat & Logs
```bash
node scripts/db-query.js get-heartbeat --agent <agent_name>
node scripts/db-query.js update-heartbeat --agent research --check token_scan
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"status":"ok"}'
node scripts/db-query.js add-executor-log --json '{"action":"process_orders","sells_processed":1,"buys_processed":0,"status":"ok"}'
node scripts/db-query.js add-research-log --json '{"check_type":"token_scan","tokens_scanned":30,"tokens_analyzed":2,"trades_proposed":1,"summary":"Scanned 30 trending, proposed 1 BUY","status":"ok"}'
node scripts/db-query.js get-research-log --limit 10
node scripts/db-query.js get-trade-stats
```

### Paper Mode (Simulated Trading)
Paper commands mirror real-mode equivalents with `paper-` prefix and identical flags:
```bash
node scripts/db-query.js get-paper-portfolio
node scripts/db-query.js get-paper-cash
node scripts/db-query.js get-paper-cash --chain base
node scripts/db-query.js get-paper-cash --chain ethereum
node scripts/db-query.js set-paper-cash --chain base --amount 10000
node scripts/db-query.js set-paper-cash --chain ethereum --amount 10000
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --symbol TOKEN
# add-paper-position: same fields as add-position + value_usd. Auto-deducts from paper_cash, auto-calculates quantity.
node scripts/db-query.js add-paper-position --json '{"id":"pp-001","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","entry_price":0.001,"value_usd":10,"stop_loss":0.0005,"take_profit_levels":[{"level":1,"price":0.002,"sellPercent":50}]}'
# For Ethereum, use "chain":"ethereum"
node scripts/db-query.js update-paper-position --id pp-001 --json '{"current_price": 0.0015, "value_usd": 15}'
# close-paper-position: auto-adds sale proceeds to paper_cash
node scripts/db-query.js close-paper-position --id pp-001 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'
node scripts/db-query.js close-paper-position --id pp-001 --quantity 5000 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'
node scripts/db-query.js add-paper-receipt --json '{"id":"pt-001","order_id":"trade-001","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","proposed_price":0.001,"quantity":10000,"amount":500}'
# For Ethereum, use "chain":"ethereum"
node scripts/db-query.js get-paper-receipts
node scripts/db-query.js get-paper-receipts --limit 10
node scripts/db-query.js get-paper-stats
```

### Portfolio Sync (On-Chain — Real Mode Only)
```bash
node scripts/db-query.js sync-portfolio --chain base
node scripts/db-query.js sync-portfolio --chain base --trigger post_trade
node scripts/db-query.js sync-portfolio --chain ethereum
node scripts/db-query.js get-sync-status
node scripts/db-query.js get-sync-status --chain base
node scripts/db-query.js get-sync-status --chain ethereum
node scripts/db-query.js set-onchain-balance --id <position_id> --balance 1000.5
```
In paper mode, `sync-portfolio` returns a message explaining sync is skipped (DB is sole source of truth).

### Analysis Cache (Token Dedup)
```bash
# Check if a token needs analysis (dedup before running analyst/risk skills)
# Returns action: "skip" or "analyze" with reason
node scripts/db-query.js check-token-status --address 0x... --chain base
node scripts/db-query.js check-token-status --address 0x... --chain ethereum
# Checks: open positions, pending buys, pending sells, watchlist, cached analysis

# Cache an avoid/reject verdict (prevents re-analysis for 24h by default)
node scripts/db-query.js cache-analysis --json '{"address":"0x...","chain":"base","symbol":"TOKEN","analysis_score":25,"verdict":"avoid","reasoning":"Low liquidity, unverified contract"}'
# For Ethereum, use "chain":"ethereum"
# With custom TTL
node scripts/db-query.js cache-analysis --json '{"address":"0x...","chain":"base","verdict":"risk_rejected","risk_score":82,"reasoning":"Top holder >30%","ttl_hours":12}'
# For Ethereum, use "chain":"ethereum"

node scripts/db-query.js get-analysis-cache
node scripts/db-query.js clear-expired-cache
```

## Data Fetching Scripts

### Token Data
```bash
node scripts/scan-tokens.js --chain solana --sort trending --limit 20
node scripts/scan-tokens.js --chain ethereum --sort trending --limit 20
node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN>
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN> --deep
node scripts/check-contract.js --changes
node scripts/check-contract.js --changes --address <TOKEN_ADDRESS> --chain <CHAIN>
```

### Portfolio Monitoring
```bash
node scripts/check-positions.js
node scripts/check-liquidity.js
node scripts/check-liquidity.js --chain base
node scripts/check-liquidity.js --chain ethereum
node scripts/portfolio-summary.js
node scripts/portfolio-summary.js --chain base
node scripts/portfolio-summary.js --chain ethereum
# On-chain sync (EVM — Safe TX Service primary, DeBank fallback; real mode only)
# Native ETH stored as gas metadata (not a position). Stablecoins accumulate as cash.
node scripts/portfolio-load-evm.js --chain base
node scripts/portfolio-load-evm.js --chain base --trigger post_trade
node scripts/portfolio-load-evm.js --chain ethereum
node scripts/portfolio-load-evm.js --chain ethereum --trigger post_trade
# On-chain sync (Solana — Helius DAS primary, RPC fallback; real mode only)
node scripts/portfolio-load-solana.js --chain solana
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```

### Wallet Tracking
```bash
node scripts/check-wallets.js
node scripts/check-wallets.js --positions
node scripts/check-wallets.js --chain base
node scripts/check-wallets.js --chain ethereum
node scripts/check-wallets.js --type smart_money
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN>
# Check holders AND auto-propose top 5 non-contract holders for wallet scoring
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN> --propose
```

### Wallet Scoring (Smart Money Detection)
```bash
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN>
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN> --add
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN> --add --label "Top holder of TOKEN"
```
Uses Birdeye (Solana + EVM) and Zerion (EVM fallback) to analyze wallet PnL.
Classifications: `smart_money` (75+), `whale` (55-74), `trader` (35-54), `retail` (0-34).

### Market Data
```bash
node scripts/market-overview.js
node scripts/market-regime.js
# → {"status":"ok","regime":"bearish","regimeChanged":true,"adjustments":{"minCashReserve":25,"baseBuyingEnabled":false,...}}
# Regime values: bullish, neutral, bearish, crisis
# Anti-whipsaw: regime only changes after 2 consecutive consistent readings
# Auto-updates portfolio_meta (key: market_regime) and heartbeat timestamp
# Read stored regime: node scripts/db-query.js get-meta --key market_regime
node scripts/narrative-check.js                         # All 26 narratives
node scripts/narrative-check.js --narrative ai_infra    # Single narrative
# → Returns momentum (hot/warming/cooling/cold), volume, top picks, rotation detection
# Narrative IDs: ai_infra, ai_agents, defi, restaking, lst, yield, payfi, rwa, prediction,
#   l2, zk, modular, intents, depin, memecoin, socialfi, gaming, nft_infra, btc_eco, btc_l2,
#   privacy, telegram, consumer, desci, degov, energy

# Deep narrative scan — find and rank top tokens within a narrative
node scripts/narrative-deep-scan.js --narrative ai_infra                  # Manual: all keywords, top 10
node scripts/narrative-deep-scan.js --narrative all --hot-only            # Only hot/warming narratives
node scripts/narrative-deep-scan.js --narrative ai_infra --quick          # Agent mode: 1 keyword, top 3
node scripts/narrative-deep-scan.js --narrative all --hot-only --quick    # Agent heartbeat use
# → Returns ranked tokens with score, suggested tier, volume, liquidity, buy ratio
```

### Heartbeat Pre-Check
```bash
node scripts/heartbeat-check.js --agent executor
# → {"agent":"executor","skip":true,"reason":"no pending orders"}
node scripts/heartbeat-check.js --agent sentinel
# → {"agent":"sentinel","skip":false,"open_positions":3}
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | `base,ethereum,solana` | Comma-separated list of active chains. Supported: `base`, `ethereum`, `solana`. |
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
