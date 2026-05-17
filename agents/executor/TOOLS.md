# TOOLS.md — Executor Agent Tool Reference

## General Notes
- All scripts output **valid JSON to stdout**. Parse the output directly — no need for `jq` unless extracting a specific field.
- Errors go to stderr. Exit code 0 = success, 1 = failure.
- **Do NOT use web_search or browser tools.** They are disabled.
- **Run one command per exec call.** Never chain commands with `&&`, `||`, or `;`. If you need multiple commands, make separate exec calls for each.

## Logging Severity Rubric
`scripts/log.js` levels — Observer's detection depends on the right level:
- `info` — routine step completed. Never actionable.
- `warn` — degraded but self-healing (retry succeeded, RPC fallback used).
- `error` — an operation did not complete (order fetch failed, process-order returned no JSON, heartbeat write failed). **Each instance is actionable.**
- `critical` — safety/integrity violation (signer key missing, heartbeat stuck, data corruption). **Immediate Observer alert.**

A silent failure looks like a quiet cycle — that is the single worst Executor path. When in doubt, log at `error` or `critical`, never `warn`.

## Chain Discovery (legacy hold-back)
```bash
node scripts/db-query.js get-chains
```
```bash
node scripts/db-query.js get-chain-config --chain <CHAIN>
```

## API CLI (`cclaw`) and legacy CLI (`db-query.js`)

Prefer `cclaw` where listed; use legacy `node scripts/db-query.js` for hold-backs (pending P5b/P6 expansion). Commands without a `cclaw` equivalent are annotated `(legacy hold-back)`.

### Portfolio & Cash (legacy hold-back)
```bash
node scripts/db-query.js get-portfolio
```
```bash
node scripts/db-query.js get-portfolio --chain <CHAIN>
```
```bash
node scripts/db-query.js get-cash
```
```bash
node scripts/db-query.js get-cash --chain <CHAIN>
```
```bash
node scripts/db-query.js get-meta --key my_key
```

### Positions (Human Interaction Only)
**Not used during the heartbeat.** Position lifecycle is owned by the `ExecuteOrderProcessor` (NestJS worker) — validation, execution, receipts, positions, and cash all run atomically there. The commands below exist for ad-hoc human queries; never call them as part of autonomous order processing.

Read positions:
```bash
cclaw positions list [--status open] [--symbol TOKEN]
```

### Order Execution (Enqueue → async via ExecuteOrderProcessor)
```bash
cclaw orders execute --id trade-001
```
Returns 202 on success (order enqueued). The `ExecuteOrderProcessor` (NestJS worker) validates, executes, writes receipt, creates/closes position, updates cash, marks order done, and emits a structured alert — all atomically. Verify on next cycle via:
```bash
cclaw orders get --id trade-001
```
Status will progress to `executed` / `failed` / `rejected`.

### Orders
Orders use a status state machine: `pending → approved → executed` (or `rejected`/`cancelled`/`failed`).

```bash
cclaw orders list
```
```bash
cclaw orders list --pending
```
```bash
cclaw orders list --status approved --action buy
```
```bash
cclaw orders list --status approved --action sell
```
```bash
cclaw orders get --id trade-001
```
```bash
node scripts/db-query.js get-order-history --limit 20
```
(legacy hold-back)

### Receipts
```bash
cclaw receipts list [--limit N]
```
```bash
cclaw receipts create --json '<Receipt>'
```

### Heartbeat & Logs
```bash
cclaw heartbeat get --agent executor
```
```bash
cclaw heartbeat ping --agent executor --check process_orders
```
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":1,"buy_orders_processed":0,"success_count":1,"status":"ok"}'
```
(legacy hold-back — `cclaw agent-logs create` pending P5b)

### Portfolio Sync (On-Chain — legacy hold-back)
```bash
node scripts/db-query.js sync-portfolio --chain <CHAIN>
```
```bash
node scripts/db-query.js sync-portfolio --chain <CHAIN> --trigger post_trade
```
```bash
node scripts/db-query.js get-sync-status
```
```bash
node scripts/db-query.js get-sync-status --chain <CHAIN>
```
```bash
node scripts/db-query.js set-onchain-balance --id <position_id> --balance 1000.5
```
`sync-portfolio` returns `{ok: false, message: 'Portfolio sync skipped...'}` when on-chain sync is disabled — proceed without action.

## Trade Execution

[P5 note: `execute-trade-evm.js`, `execute-trade-solana.js`, `check-safe-status.js`, `check-squads-status.js`, `token-metrics.js`, `portfolio-load-evm.js`, and `portfolio-load-solana.js` were deleted in P5. Trade execution is now fully handled by the `ExecuteOrderProcessor` NestJS worker via `cclaw orders execute --id X`. The executor agent does NOT call execution scripts directly.]

### Execution path (via NestJS — post-P5)

```bash
cclaw orders execute --id ORDER_ID
```
Returns 202 = order enqueued. `ExecuteOrderProcessor` handles:
- EVM: Safe wallet + 1inch (Safe + multi-send + `SAFE_SIGNER_KEY`)
- Solana: Squads + Jupiter (`SQUADS_VAULT_ADDRESS`, `SQUADS_SIGNER_KEY`)
Verify on next heartbeat:
```bash
cclaw orders get --id ORDER_ID
```

### Order Output Statuses
- `executed` — transaction confirmed on-chain
- `queued_in_safe`/`queued_in_squads` — proposed to multisig, needs more signatures
- `failed` — with error message

### Multisig Transaction Tracker
Queued multisig transactions are tracked by the MultisigTrackerProcessor (NestJS worker, every 5 min). You do NOT handle them.

### On-Chain Portfolio Sync
On-chain portfolio sync is handled by the PortfolioSyncProcessor (NestJS worker). You do NOT trigger loaders — they run automatically.

Read sync status:
```bash
node scripts/db-query.js get-sync-status
```
(legacy hold-back)

## Emergency & Alerts

### Emergency Executor (No LLM Required)
```bash
node scripts/emergency-executor.js
```
Script-only sell executor — runs when executor agent can't reach any model. Processes SELL orders only (never buys). Delegates to the `ExecuteOrderProcessor` via direct DB mutation as a fallback path.

### Send Alert (legacy hold-back)
```bash
node scripts/send-alert.js --type trade_executed --agent executor --message "BUY executed: TOKEN"
```
```bash
node scripts/send-alert.js --type trade_failed --agent executor --message "Order fetch failed: <reason>"
```
```bash
node scripts/send-alert.js --type model_failure --agent executor --message "Agent failed"
```
```bash
node scripts/send-alert.js --type emergency_mode --agent executor --message "Emergency mode active"
```
```bash
node scripts/send-alert.js --type system_health --agent executor --message "log/heartbeat write failed: <reason>"
```
```bash
node scripts/send-alert.js --type recovered --agent executor --message "Back to normal"
```
Alerts route to the correct Telegram supergroup topic automatically. Every successful `node scripts/send-alert.js` invocation also writes an `[info] [send-alert]` entry to `/tmp/openclaw/system.log` — this is Observer's correlation signal for silent-crash detection.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | Per `get-chains` | Comma-separated list of active chains. Run `node scripts/db-query.js get-chains` to see available chains. |

## Important Notes

- All scripts return JSON to stdout — parse the output, don't display it raw
- If a script fails, log the error and report the failure
- NEVER log or expose `SAFE_SIGNER_KEY` or `SQUADS_SIGNER_KEY` in any output
- Scripts cache responses for 60 seconds to avoid redundant API calls
- The database auto-creates and auto-migrates on first query
- Slippage limits: 5% moonshot, 2% conviction/base
- Stale order protection: reject if price drifted >10% from proposal

### Position Statuses
| Status | Meaning |
|--------|---------|
| `open` | Active, monitored by Sentinel |
| `draft` | BUY queued in multisig — committed but not yet confirmed on-chain |
| `pending_exit` | SELL queued in multisig — awaiting confirmation |
| `partial_exit` | Partial sell executed |
| `closed` | Fully exited |
| `pending_analysis` | Discovered on-chain, awaiting analysis |
