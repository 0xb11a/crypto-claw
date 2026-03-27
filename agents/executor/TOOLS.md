# TOOLS.md — Executor Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. Parse the output directly — no need for `jq` unless extracting a specific field.
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled.

## Database CLI (db-query.js)

All wallet data lives in SQLite. Interact through `db-query.js` — never access the DB file directly.

### Portfolio & Cash
```bash
node scripts/db-query.js get-portfolio
node scripts/db-query.js get-portfolio --chain base
node scripts/db-query.js get-cash
node scripts/db-query.js get-cash --chain base
node scripts/db-query.js set-cash --chain base --amount 5000
node scripts/db-query.js get-gas
node scripts/db-query.js get-gas --chain base
node scripts/db-query.js get-meta --key my_key
node scripts/db-query.js set-meta --key my_key --value my_value
```

### Positions
```bash
node scripts/db-query.js get-positions
node scripts/db-query.js get-positions --status open
node scripts/db-query.js get-positions --symbol TOKEN
node scripts/db-query.js add-position --json '{"id":"pos-001","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","entry_price":0.001,"quantity":10000,"stop_loss":0.0005,"take_profit_levels":[{"level":1,"price":0.002,"sellPercent":50}]}'
node scripts/db-query.js update-position --id pos-001 --json '{"current_price": 0.0015}'
node scripts/db-query.js close-position --id pos-001 --json '{"exit_price": 0.002, "exit_reason": "stop_loss"}'
node scripts/db-query.js close-position --id pos-001 --quantity 5000 --json '{"exit_price": 0.002, "exit_reason": "take_profit_partial"}'
```

### Order Processing (Atomic)
```bash
# Process a single order atomically (validate → execute → receipt → position → cash → mark done → alert)
node scripts/process-order.js --order-id trade-001
# Output: JSON with { ok, order_id, action, status, receipt_id, position_id, executed_price, ... }
```

### Orders
Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).

```bash
node scripts/db-query.js get-orders
node scripts/db-query.js get-orders --pending
node scripts/db-query.js get-orders --status approved --action buy
node scripts/db-query.js get-orders --status approved --action sell
node scripts/db-query.js get-order --id trade-001
node scripts/db-query.js get-order-history --limit 20
node scripts/db-query.js mark-order-executed --id trade-001
node scripts/db-query.js mark-order-executed --id trade-001 --status failed --reason "tx_failed"
```

### Receipts
```bash
node scripts/db-query.js get-receipts --limit 10
node scripts/db-query.js add-receipt --json '{"id":"rcpt-001","order_id":"trade-001","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","status":"executed","safe_tx_hash":"0x...","onchain_tx_hash":"0x...","executed_price":0.00098,"slippage":0.02}'
```

### Heartbeat & Logs
```bash
node scripts/db-query.js get-heartbeat --agent executor
node scripts/db-query.js update-heartbeat --agent executor --check process_orders
node scripts/db-query.js add-executor-log --json '{"action":"process_orders","sells_processed":1,"buys_processed":0,"status":"ok"}'
node scripts/db-query.js get-trade-stats
```

### Paper Mode
Paper commands mirror real-mode equivalents with `paper-` prefix and identical flags:
```bash
node scripts/db-query.js get-paper-portfolio
node scripts/db-query.js get-paper-cash
node scripts/db-query.js get-paper-cash --chain base
node scripts/db-query.js set-paper-cash --chain base --amount 10000
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --symbol TOKEN
# add-paper-position: same fields as add-position + value_usd. Auto-deducts from paper_cash, auto-calculates quantity.
node scripts/db-query.js add-paper-position --json '{"id":"pp-001","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","entry_price":0.001,"value_usd":10,"stop_loss":0.0005,"take_profit_levels":[{"level":1,"price":0.002,"sellPercent":50}]}'
node scripts/db-query.js update-paper-position --id pp-001 --json '{"current_price": 0.0015, "value_usd": 15}'
node scripts/db-query.js close-paper-position --id pp-001 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'
node scripts/db-query.js close-paper-position --id pp-001 --quantity 5000 --json '{"exit_price": 0.002, "exit_reason": "tp1_hit"}'
node scripts/db-query.js add-paper-receipt --json '{"id":"pt-001","order_id":"trade-001","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","proposed_price":0.001,"quantity":10000,"amount":500}'
node scripts/db-query.js get-paper-receipts
node scripts/db-query.js get-paper-receipts --limit 10
node scripts/db-query.js get-paper-stats
```

### Portfolio Sync (On-Chain — Real Mode Only)
```bash
node scripts/db-query.js sync-portfolio --chain base
node scripts/db-query.js sync-portfolio --chain base --trigger post_trade
node scripts/db-query.js get-sync-status
node scripts/db-query.js get-sync-status --chain base
node scripts/db-query.js set-onchain-balance --id <position_id> --balance 1000.5
```

## Trade Execution (Real Mode Only)

### EVM (Safe Wallet) — execute-trade-evm.js
```bash
node scripts/execute-trade-evm.js --action buy --chain base --address 0xTOKEN --symbol TOKEN --amount 500 --max-slippage 5 --tier moonshot --deadline 300
node scripts/execute-trade-evm.js --action sell --chain base --address 0xTOKEN --symbol TOKEN --amount all --max-slippage 5
node scripts/execute-trade-evm.js --action sell --chain base --address 0xTOKEN --symbol TOKEN --amount 10000 --max-slippage 2 --deadline 300
```
Handles: 1inch swap quoting, ERC-20 approvals, Safe multi-send, signing with `SAFE_SIGNER_KEY`.
Requires: `SAFE_ADDRESS_<CHAIN>`, `SAFE_SIGNER_KEY`, `RPC_<CHAIN>`.

### Solana (Squads Multisig) — execute-trade-solana.js
```bash
node scripts/execute-trade-solana.js --action buy --chain solana --address <MINT> --symbol TOKEN --amount 500 --max-slippage 5 --tier moonshot
node scripts/execute-trade-solana.js --action sell --chain solana --address <MINT> --symbol TOKEN --amount all --max-slippage 5
```
Handles: Jupiter swap quoting, Squads vault tx creation, proposal, approval, execution.
Requires: `SQUADS_VAULT_ADDRESS` (or `SQUADS_MULTISIG_ADDRESS`), `SQUADS_SIGNER_KEY`, `RPC_SOL`.

### Output Statuses
- `executed` — transaction confirmed on-chain (includes `txHash`/`txSignature`)
- `queued_in_safe`/`queued_in_squads` — proposed to multisig, needs more signatures (includes `safeHash`/`squadsTransactionIndex`)
- `failed` — with error message

### Multisig Status
```bash
# Safe wallet: nonce, threshold, owners, balances, pending txs
node scripts/check-safe-status.js --chain base
node scripts/check-safe-status.js --chain base --safe-hash 0xABC123...
# Squads multisig: threshold, members, vault balances
node scripts/check-squads-status.js
node scripts/check-squads-status.js --pending
```

### Multisig Transaction Tracker (Background — No LLM)
```bash
node scripts/track-multisig.js
# → {"checked":2,"confirmed":1,"pending":1,"failed":0}
```
Tracks `draft` positions (BUY queued) and `pending_exit` positions (SELL queued).
When confirmed on-chain: receipt → `executed`, position activated/closed, portfolio synced.
When rejected: receipt → `reverted`, draft positions deleted (cash refunded), pending_exit reverted to `open`.

### Token Metrics (Price Validation)
```bash
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>
```

### On-Chain Portfolio Sync (Real Mode Only)
```bash
node scripts/portfolio-load-evm.js --chain base
node scripts/portfolio-load-evm.js --chain base --trigger post_trade
node scripts/portfolio-load-solana.js --chain solana
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```
Native ETH/SOL stored as gas metadata (not a position). Stablecoins accumulate as cash.

## Emergency & Alerts

### Emergency Executor (No LLM Required)
```bash
# Script-only sell executor — runs when executor agent can't reach any model
# Processes SELL orders only (never buys). Calls execute-trade-evm.js / execute-trade-solana.js
# In paper mode: simulates execution, writes to paper tables
node scripts/emergency-executor.js
```

### Send Alert
```bash
node scripts/send-alert.js --type model_failure --agent executor --message "Agent failed"
node scripts/send-alert.js --type emergency_mode --agent executor --message "Emergency mode active"
node scripts/send-alert.js --type recovered --agent executor --message "Back to normal"
```

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | `base,solana` | Comma-separated list of active chains. Supported: `base`, `solana`. |
| `PAPER_MODE` | `false` | Enable simulated trading (no real transactions, no on-chain sync) |

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- If a script fails, log the error and report the failure
- NEVER log or expose `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` in any output
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query
- Slippage limits: 5% moonshot, 2% conviction/base
- Stale order protection: reject if price drifted >10% from proposal

#### Position Statuses
| Status | Meaning |
|--------|---------|
| `open` | Active, monitored by Sentinel |
| `draft` | BUY queued in multisig — committed but not yet confirmed on-chain |
| `pending_exit` | SELL queued in multisig — awaiting confirmation |
| `partial_exit` | Partial sell executed |
| `closed` | Fully exited |
| `pending_analysis` | Discovered on-chain, awaiting analysis |
