# TOOLS.md — Sentinel Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. Parse the output directly — no need for `jq` unless extracting a specific field.
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.
- `SAFE_ID` is exported by entrypoint.sh — both `cclaw` and legacy `db-query.js` pick it up automatically.

## Logging Severity Rubric
`scripts/log.js` levels — Observer's detection depends on the right level:
- `info` — routine step completed. Never actionable.
- `warn` — degraded but self-healing (retry succeeded, cache miss, fallback used).
- `error` — an operation did not complete (check-positions crashed, add-order failed, sell order not written). **Each instance is actionable.**
- `critical` — safety/integrity violation (positions unmonitored, signer drained, data corruption). **Immediate Observer alert.**

A failed monitoring check with no `error` log row is itself a bug — an unmonitored position is a silent emergency.

## Chain Discovery (legacy hold-back)
```bash
node scripts/db-query.js get-chains
```
```bash
node scripts/db-query.js get-chain-config --chain <CHAIN>
```

## API CLI (`cclaw`) and legacy CLI (`db-query.js`)

Prefer `cclaw` where listed; use legacy `node scripts/db-query.js` for hold-backs (commands without a `cclaw` equivalent yet, pending P5b/P6 expansion). Commands without a `cclaw` equivalent are annotated `(legacy hold-back)`.

### Positions
```bash
cclaw positions list
```
```bash
cclaw positions list --status open
```
```bash
cclaw positions list --symbol TOKEN
```

### Orders (Sentinel → Executor)

Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).
Sell orders written by sentinel are auto-approved.

```bash
cclaw orders list
```
```bash
cclaw orders list --pending
```
```bash
cclaw orders get --id sell-001
```
```bash
node scripts/db-query.js get-order-history --limit 20
```
(legacy hold-back)

Write a sell order (auto-approved):
```bash
cclaw orders propose --json '{"id":"sell-001","action":"sell","symbol":"TOKEN","address":"0x...","chain":"<CHAIN>","amount":"all","reason":"stop_loss_hit","urgency":"immediate"}'
```

### Receipts (Read-Only — written by Executor)
```bash
cclaw receipts list --limit 10
```
```bash
node scripts/db-query.js get-trade-stats
```
(legacy hold-back)

### Sentinel Alerts
```bash
cclaw alerts create --json '{"id":"alert-001","symbol":"TOKEN","chain":"<CHAIN>","alert_type":"liquidity_drop","severity":"high","details":"Liquidity dropped 25% in 5 minutes"}'
```

### Liquidity Snapshots (legacy hold-back)
```bash
node scripts/db-query.js get-liquidity --address 0x... --chain <CHAIN>
```
```bash
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots (legacy hold-back)
```bash
node scripts/db-query.js get-contract-snapshots --address 0x... --chain <CHAIN>
```
```bash
node scripts/db-query.js get-contract-snapshots --address 0x... --chain <CHAIN> --limit 10
```
```bash
node scripts/db-query.js add-contract-snapshot --address 0x... --chain <CHAIN> --json '<safety_data_json>'
```

### Heartbeat & Logs
```bash
cclaw heartbeat get --agent sentinel
```
```bash
cclaw heartbeat overdue --agent sentinel
```
```bash
cclaw heartbeat ping --agent sentinel --check price_check
```
```bash
node scripts/db-query.js get-sentinel-log --limit 12
```
(legacy hold-back)
```bash
node scripts/db-query.js add-sentinel-log --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```
(legacy hold-back — `cclaw agent-logs create` pending P5b)

### Smart-Money Exit Signals (Read-Only, legacy hold-back)
Per-swap signals written by the WalletActivityProcessor (NestJS worker, every 30 min, 24 h retention).
Sentinel consumes SELL signals on tokens we currently hold.
```bash
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
```
```bash
node scripts/db-query.js get-smart-money-signals --since 1h --action sell --tokens-in-positions --limit 50
```
The `--tokens-in-positions` flag joins against the deployment's positions table with status in `open|partial_exit|draft|pending_exit`. Empty result = no smart-money exits on held tokens.

## Monitoring Data Sources

[cclaw expansion pending P5b — the monitoring scripts (`check-positions.js`, `check-liquidity.js`, `check-wallets.js`, `check-contract.js`) were deleted in P5. Their functionality is now handled by NestJS workers (PriceCheckProcessor, LiquidityCheckProcessor, WalletMonitorProcessor, ContractSafetyProcessor). The Sentinel agent reads monitoring data via the sources below.]

### Position Data (cclaw)
```bash
cclaw positions list --status open
```

### Liquidity Snapshots (legacy hold-back)
```bash
node scripts/db-query.js get-liquidity --address 0x... --chain <CHAIN> --limit 2
```
```bash
node scripts/db-query.js add-liquidity-snapshot --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots (legacy hold-back)
```bash
node scripts/db-query.js get-contract-snapshots --address 0x... --chain <CHAIN> --limit 2
```
```bash
node scripts/db-query.js add-contract-snapshot --address 0x... --chain <CHAIN> --json '<safety_data_json>'
```

### Smart-Money Signals — covers wallet/dev activity (legacy hold-back)
```bash
node scripts/db-query.js get-smart-money-signals --since 30m --action sell --tokens-in-positions --group-by token
```
```bash
node scripts/db-query.js get-smart-money-signals --since 1h --action sell --tokens-in-positions --limit 50
```

## Emergency & Alerts

### Emergency Sentinel (No LLM Required)
```bash
node scripts/emergency-sentinel.js
```
Script-only position monitor — runs when sentinel agent can't reach any model. Checks: stop-loss, take-profit, severe loss (>30%), liquidity drain (>50% drop), low liquidity (<$5k). Writes sell orders to the orders table, logs to sentinel_log.

### Send Alert
```bash
node scripts/send-alert.js --type sell_triggered --agent sentinel --message "Stop-loss triggered for TOKEN"
```
```bash
node scripts/send-alert.js --type rug_warning --agent sentinel --message "Liquidity drain or failed monitoring check — capital exposed"
```
```bash
node scripts/send-alert.js --type model_failure --agent sentinel --message "Agent failed"
```
```bash
node scripts/send-alert.js --type emergency_mode --agent sentinel --message "Emergency mode active"
```
```bash
node scripts/send-alert.js --type recovered --agent sentinel --message "Back to normal"
```
Alerts route to the correct Telegram supergroup topic automatically. send-alert.js is a retained script (ADR-0025; supersession pending P5c).

Use `rug_warning` when a monitoring script (`check-positions`, `check-liquidity`, `check-wallets`, `check-contract`) exits non-zero or returns no JSON — an unmonitored position is an emergency. Use `sell_triggered` when a sell order was successfully written (or when a sell-order write FAILED — see AGENTS.md § Error Self-Reporting).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | Per `get-chains` | Comma-separated list of active chains. Run `node scripts/db-query.js get-chains` to see available chains. |

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
