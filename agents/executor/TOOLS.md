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

During P4–P5, both CLI surfaces are available. Prefer `cclaw` where listed; use legacy `node scripts/db-query.js` for hold-backs (deleted in P5).

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
**Not used during the heartbeat.** Position lifecycle is owned by `node scripts/process-order.js` — validation, execution, receipts, positions, and cash all run atomically there. The commands below exist for ad-hoc human queries; never call them as part of autonomous order processing.

Read positions:
```bash
cclaw positions list [--status open] [--symbol TOKEN]
```

### Order Processing (Atomic — legacy hold-back)
```bash
node scripts/process-order.js --order-id trade-001
```
Output: JSON with `{ ok, order_id, action, status, receipt_id, position_id, executed_price, ... }`. This script validates, executes, writes receipt, creates/closes position, updates cash, marks order done, and sends an alert — all atomically.

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
(legacy hold-back — `cclaw agent-logs create` pending P5)

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

### EVM (Safe Wallet) — execute-trade-evm.js

All EVM chains use the same Safe + 1inch stack.

```bash
node scripts/execute-trade-evm.js --action buy --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount 500 --max-slippage 5 --tier moonshot --deadline 300
```
```bash
node scripts/execute-trade-evm.js --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount all --max-slippage 5
```
```bash
node scripts/execute-trade-evm.js --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount 10000 --max-slippage 2 --deadline 300
```
Handles: 1inch swap quoting, ERC-20 approvals, Safe multi-send, signing with `SAFE_SIGNER_KEY`.
Requires: `SAFE_ADDRESS_<CHAIN>`, `SAFE_SIGNER_KEY`, `RPC_<CHAIN>` per chain.

### Solana (Squads Multisig) — execute-trade-solana.js
```bash
node scripts/execute-trade-solana.js --action buy --chain solana --address <MINT> --symbol TOKEN --amount 500 --max-slippage 5 --tier moonshot
```
```bash
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
node scripts/check-safe-status.js --chain <CHAIN>
```
```bash
node scripts/check-safe-status.js --chain <CHAIN> --safe-hash 0xABC123...
```
```bash
node scripts/check-squads-status.js
```
```bash
node scripts/check-squads-status.js --pending
```

### Multisig Transaction Tracker
Queued multisig transactions are tracked by the MultisigTrackerProcessor (NestJS worker, every 5 min; Solana also handled by legacy `entrypoint.sh:run_multisig_tracker_loop` during P4). You do NOT handle them.

### Token Metrics (Price Validation)
```bash
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>
```

### On-Chain Portfolio Sync
```bash
node scripts/portfolio-load-evm.js --chain <CHAIN>
```
```bash
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger post_trade
```
```bash
node scripts/portfolio-load-solana.js --chain solana
```
```bash
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```
Native ETH/SOL stored as gas metadata (not a position). Stablecoins accumulate as cash. Loaders return `{status: 'skipped'}` when on-chain sync is disabled — proceed without action.

## Emergency & Alerts

### Emergency Executor (No LLM Required)
```bash
node scripts/emergency-executor.js
```
Script-only sell executor — runs when executor agent can't reach any model. Processes SELL orders only (never buys). Calls `process-order.js` per order.

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
