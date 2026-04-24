# TOOLS.md — Sentinel Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. Parse the output directly — no need for `jq` unless extracting a specific field.
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.

## Logging Severity Rubric
`scripts/log.js` levels — Observer's detection depends on the right level:
- `info` — routine step completed. Never actionable.
- `warn` — degraded but self-healing (retry succeeded, cache miss, fallback used).
- `error` — an operation did not complete (check-positions crashed, add-order failed, sell order not written). **Each instance is actionable.**
- `critical` — safety/integrity violation (positions unmonitored, signer drained, data corruption). **Immediate Observer alert.**

A failed monitoring check with no `error` log row is itself a bug — an unmonitored position is a silent emergency.

## Chain Discovery
```bash
# List all active chains
node scripts/db-query.js get-chains
# Get config for a specific chain (cash token, explorer, wallet type, etc.)
node scripts/db-query.js get-chain-config --chain <CHAIN>
```

## Database CLI (db-query.js)

All wallet data lives in SQLite. Interact through `db-query.js` — never access the DB file directly.

### Portfolio & Cash (Read-Only)
```bash
node scripts/db-query.js get-portfolio
node scripts/db-query.js get-portfolio --chain <CHAIN>
node scripts/db-query.js get-cash
node scripts/db-query.js get-cash --chain <CHAIN>
node scripts/db-query.js get-gas
node scripts/db-query.js get-gas --chain <CHAIN>
node scripts/db-query.js get-meta --key my_key
```

### Positions
```bash
node scripts/db-query.js get-positions
node scripts/db-query.js get-positions --status open
node scripts/db-query.js get-positions --symbol TOKEN
node scripts/db-query.js update-position --id pos-001 --json '{"current_price": 0.0015}'
```

### Orders (Sentinel → Executor)

Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).
Sell orders written by sentinel are auto-approved.

```bash
node scripts/db-query.js get-orders
node scripts/db-query.js get-orders --pending
node scripts/db-query.js get-order --id sell-001
node scripts/db-query.js get-order-history --limit 20

# Write a sell order (auto-approved)
node scripts/db-query.js add-order --json '{"id":"sell-001","action":"sell","symbol":"TOKEN","address":"0x...","chain":"<CHAIN>","amount":"all","reason":"stop_loss_hit","urgency":"immediate"}'
```

### Receipts (Read-Only — written by Executor)
```bash
node scripts/db-query.js get-receipts --limit 10
```
```bash
node scripts/db-query.js get-trade-stats
```

### Sentinel Alerts
```bash
node scripts/db-query.js add-alert --json '{"id":"alert-001","symbol":"TOKEN","chain":"<CHAIN>","alert_type":"liquidity_drop","severity":"high","details":"Liquidity dropped 25% in 5 minutes"}'
```

### Liquidity Snapshots
```bash
node scripts/db-query.js get-liquidity --address 0x... --chain <CHAIN>
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots
```bash
node scripts/db-query.js get-contract-snapshots --address 0x... --chain <CHAIN>
node scripts/db-query.js get-contract-snapshots --address 0x... --chain <CHAIN> --limit 10
node scripts/db-query.js add-contract-snapshot --address 0x... --chain <CHAIN> --json '<safety_data_json>'
```

### Heartbeat & Logs
```bash
node scripts/db-query.js get-heartbeat --agent sentinel
node scripts/db-query.js get-overdue-checks --agent sentinel
node scripts/db-query.js update-heartbeat --agent sentinel --check price_check
node scripts/db-query.js get-sentinel-log --limit 12
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```

### Smart-Money Exit Signals (Read-Only)
Per-swap signals written by the activity-wallets-bg loop (every 30 min, 24 h retention).
Sentinel consumes SELL signals on tokens we currently hold.
```bash
# Heartbeat use — aggregate sells on held tokens
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token

# Per-position raw sell rows for a deeper look
node scripts/db-query.js get-smart-money-signals --since 1h --action sell --tokens-in-positions --limit 50
```
The `--tokens-in-positions` flag joins against `positions` (or `paper_positions` when `PAPER_MODE=true`) with status in `open|partial_exit|draft|pending_exit`. Empty result = no smart-money exits on held tokens.

### Paper Mode
Paper commands mirror real-mode equivalents with `paper-` prefix and identical flags:
```bash
node scripts/db-query.js get-paper-portfolio
node scripts/db-query.js get-paper-cash
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --symbol TOKEN
node scripts/db-query.js update-paper-position --id pp-001 --json '{"current_price": 0.0015, "value_usd": 15}'
node scripts/db-query.js get-paper-receipts --limit 10
node scripts/db-query.js get-paper-stats
```

## Monitoring Scripts

### Position Monitoring
```bash
# Current prices for all positions (reads from DB, respects PAPER_MODE)
node scripts/check-positions.js
# Liquidity for all open positions
node scripts/check-liquidity.js
node scripts/check-liquidity.js --chain <CHAIN>
```

### Wallet Monitoring
```bash
node scripts/check-wallets.js
node scripts/check-wallets.js --positions
node scripts/check-wallets.js --chain <CHAIN>
node scripts/check-wallets.js --type smart_money
node scripts/check-wallets.js --limit <N>
```
Caps at 10 wallets per chain by default (override with `--limit N` or `CHECK_WALLETS_LIMIT_PER_CHAIN`). Fail-fast on 3 consecutive errors per chain. `skippedByCap` in JSON output reports how many wallets were not checked this cycle.

### Contract Safety Monitoring
```bash
# Check contract changes for all open positions (snapshot diff)
node scripts/check-contract.js --changes
node scripts/check-contract.js --changes --address <TOKEN_ADDRESS> --chain <CHAIN>
```

## Emergency & Alerts

### Emergency Sentinel (No LLM Required)
```bash
# Script-only position monitor — runs when sentinel agent can't reach any model
# Checks: stop-loss, take-profit, severe loss (>30%), liquidity drain (>50% drop), low liquidity (<$5k)
# Writes sell orders to the orders table, logs to sentinel_log
node scripts/emergency-sentinel.js
```

### Send Alert
```bash
# Alerts route to the correct Telegram supergroup topic automatically
# sell_triggered → Sentinel topic | rug_warning/model_failure/emergency_mode → Alerts topic
node scripts/send-alert.js --type sell_triggered --agent sentinel --message "Stop-loss triggered for TOKEN"
node scripts/send-alert.js --type rug_warning --agent sentinel --message "Liquidity drain or failed monitoring check — capital exposed"
node scripts/send-alert.js --type model_failure --agent sentinel --message "Agent failed"
node scripts/send-alert.js --type emergency_mode --agent sentinel --message "Emergency mode active"
node scripts/send-alert.js --type recovered --agent sentinel --message "Back to normal"
```

Use `rug_warning` when a monitoring script (`check-positions`, `check-liquidity`, `check-wallets`, `check-contract`) exits non-zero or returns no JSON — an unmonitored position is an emergency. Use `sell_triggered` when a sell order was successfully written (or when a sell-order write FAILED — see AGENTS.md § Error Self-Reporting).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | Per `get-chains` | Comma-separated list of active chains. Run `get-chains` to see available chains. |
| `PAPER_MODE` | `false` | Enable simulated trading (no real transactions, no on-chain sync) |

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- If a script fails, log the error and continue monitoring
- NEVER pass wallet private keys to any script
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query

### Position Statuses
| Status | Meaning |
|--------|---------|
| `open` | Active, monitored by Sentinel |
| `draft` | BUY queued in multisig — committed but not yet confirmed on-chain |
| `pending_exit` | SELL queued in multisig — awaiting confirmation |
| `partial_exit` | Partial sell executed |
| `closed` | Fully exited |
| `pending_analysis` | Discovered on-chain, awaiting analysis |
