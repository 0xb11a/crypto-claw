# TOOLS.md — Sentinel Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. Parse the output directly — no need for `jq` unless extracting a specific field.
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled. All market data comes from the scripts below.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.
- `SAFE_ID` is exported by entrypoint.sh — `cclaw` picks it up automatically.

## Logging Severity Rubric
`scripts/log.js` levels — Observer's detection depends on the right level:
- `info` — routine step completed. Never actionable.
- `warn` — degraded but self-healing (retry succeeded, cache miss, fallback used).
- `error` — an operation did not complete (cclaw positions list crashed, cclaw orders propose failed, sell order not written). **Each instance is actionable.**
- `critical` — safety/integrity violation (positions unmonitored, signer drained, data corruption). **Immediate Observer alert.**

A failed monitoring check with no `error` log row is itself a bug — an unmonitored position is a silent emergency.

## Chain Discovery
```bash
cclaw system chains
```
```bash
cclaw system chain-config --chain <CHAIN>
```

## API CLI (`cclaw`)

All wallet data is accessed via `cclaw <resource> <action>`. Run one command per exec call.

### Positions
```bash
cclaw positions list
```
```bash
cclaw positions list --status open
```
```bash
cclaw positions list --chain <CHAIN> --status open
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
cclaw orders history --limit 20
```

Write a sell order (auto-approved):
```bash
cclaw orders propose --json '{"id":"sell-001","action":"sell","symbol":"TOKEN","address":"0x...","chain":"<CHAIN>","amount":"all","reason":"stop_loss_hit","urgency":"immediate"}'
```

### Receipts (Read-Only — written by Executor)
```bash
cclaw receipts list --limit 10
```
```bash
cclaw system trade-stats
```

### Sentinel Alerts
```bash
cclaw alerts create --json '{"id":"alert-001","symbol":"TOKEN","chain":"<CHAIN>","alert_type":"liquidity_drop","severity":"high","details":"Liquidity dropped 25% in 5 minutes"}'
```

### Liquidity Snapshots
```bash
cclaw liquidity list --address 0x... --chain <CHAIN>
```
```bash
cclaw liquidity add --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots
```bash
cclaw contracts list --address 0x... --chain <CHAIN>
```
```bash
cclaw contracts list --address 0x... --chain <CHAIN> --limit 10
```
```bash
cclaw contracts add --address 0x... --chain <CHAIN> --json '<safety_data_json>'
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
cclaw logs sentinel list --limit 12
```
```bash
cclaw logs sentinel append --json '{"check_type":"all","positions_checked":5,"alerts_generated":0,"sells_executed":0,"status":"ok"}'
```

### Smart-Money Exit Signals (Read-Only)
Per-swap signals written by the WalletActivityProcessor (NestJS worker, every 30 min, 24 h retention).
Sentinel consumes SELL signals on tokens we currently hold.
```bash
cclaw wallets signals --since 30m --action sell --tokens-in-positions --group-by token
```
```bash
cclaw wallets signals --since 1h --action sell --tokens-in-positions --limit 50
```
The `--tokens-in-positions` flag joins against the deployment's positions table with status in `open|partial_exit|draft|pending_exit`. Empty result = no smart-money exits on held tokens.

## Monitoring Data Sources

[cclaw expansion pending — the monitoring scripts (`check-positions.js`, `check-liquidity.js`, `check-wallets.js`, `check-contract.js`) were deleted in P5. Their functionality is now handled by NestJS workers (PriceCheckProcessor, LiquidityCheckProcessor, WalletMonitorProcessor, ContractSafetyProcessor). The Sentinel agent reads monitoring data via the sources below.]

### Position Data (cclaw)
```bash
cclaw positions list --status open
```

### Liquidity Snapshots
```bash
cclaw liquidity list --address 0x... --chain <CHAIN> --limit 2
```
```bash
cclaw liquidity add --address 0x... --chain <CHAIN> --liquidity 50000
```

### Contract Snapshots
```bash
cclaw contracts list --address 0x... --chain <CHAIN> --limit 2
```
```bash
cclaw contracts add --address 0x... --chain <CHAIN> --json '<safety_data_json>'
```

### Smart-Money Signals — covers wallet/dev activity
```bash
cclaw wallets signals --since 30m --action sell --tokens-in-positions --group-by token
```
```bash
cclaw wallets signals --since 1h --action sell --tokens-in-positions --limit 50
```

## Emergency & Alerts

### Emergency Sentinel (No LLM Required)
```bash
node scripts/emergency-sentinel.js
```
Script-only position monitor — runs when sentinel agent can't reach any model. Checks: stop-loss, take-profit, severe loss (>30%), liquidity drain (>50% drop), low liquidity (<$5k). Writes sell orders to the orders table, logs to sentinel_log.

### Send Alert
```bash
cclaw alerts send --type sell_triggered --agent sentinel --message "Stop-loss triggered for TOKEN"
```
```bash
cclaw alerts send --type rug_warning --agent sentinel --message "Liquidity drain or failed monitoring check — capital exposed"
```
```bash
cclaw alerts send --type model_failure --agent sentinel --message "Agent failed"
```
```bash
cclaw alerts send --type emergency_mode --agent sentinel --message "Emergency mode active"
```
```bash
cclaw alerts send --type recovered --agent sentinel --message "Back to normal"
```
Alerts route to the correct Telegram supergroup topic automatically. `cclaw alerts send` returns `{ "accepted": true }` immediately; delivery is fire-and-forget (ADR-0028).

Use `rug_warning` when a monitoring script exits non-zero or returns no JSON — an unmonitored position is an emergency. Use `sell_triggered` when a sell order was successfully written (or when a sell-order write FAILED — see AGENTS.md § Error Self-Reporting).

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | Per `cclaw system chains` | Comma-separated list of active chains. Run `cclaw system chains` to see available chains. |

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
