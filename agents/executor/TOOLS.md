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
- `error` — an operation did not complete (get-orders failed, process-order returned no JSON, add-executor-log failed). **Each instance is actionable.**
- `critical` — safety/integrity violation (signer key missing, heartbeat stuck, data corruption). **Immediate Observer alert.**

A silent DB failure looks like a quiet cycle — that is the single worst Executor path. When in doubt, log at `error` or `critical`, never `warn`.

## Chain Discovery
```bash
# List all active chains
node scripts/db-query.js get-chains
# Get config for a specific chain (cash token, explorer, wallet type, etc.)
node scripts/db-query.js get-chain-config --chain <CHAIN>
```

## Database CLI (db-query.js)

All wallet data lives in SQLite. Interact through `db-query.js` — never access the DB file directly.

### Portfolio & Cash
```bash
node scripts/db-query.js get-portfolio
node scripts/db-query.js get-portfolio --chain <CHAIN>
node scripts/db-query.js get-cash
node scripts/db-query.js get-cash --chain <CHAIN>
node scripts/db-query.js set-cash --chain <CHAIN> --amount 5000
node scripts/db-query.js get-gas
node scripts/db-query.js get-gas --chain <CHAIN>
node scripts/db-query.js get-meta --key my_key
node scripts/db-query.js set-meta --key my_key --value my_value
```

### Positions (Human Interaction Only)
**Not used during the heartbeat.** Position lifecycle is owned by `process-order.js` — validation, execution, receipts, positions, and cash all run atomically there. The commands below exist for ad-hoc human queries; never call them as part of autonomous order processing.
- Read: `db-query.js get-positions [--status open] [--symbol TOKEN]`.
- Mutate (human only): `add-position`, `update-position --id <ID> --json '{current_price,…}'`, `close-position --id <ID> [--quantity <N>] --json '{exit_price, exit_reason}'`. Position schema: `{id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels:[{level,price,sellPercent}]}`.

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
- `db-query.js get-receipts [--limit N]`.
- `db-query.js add-receipt --json '<Receipt>'` — schema: `{id, order_id, action, symbol, address, chain, status, safe_tx_hash?, onchain_tx_hash?, executed_price, slippage}`.

### Heartbeat & Logs
```bash
node scripts/db-query.js get-heartbeat --agent executor
node scripts/db-query.js update-heartbeat --agent executor --check process_orders
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":1,"buy_orders_processed":0,"success_count":1,"status":"ok"}'
```

### Paper Mode
Paper commands mirror real-mode equivalents with `paper-` prefix and identical flags. During the heartbeat, `process-order.js` handles paper positions, receipts, and cash atomically — same as real mode — so the mutation commands below are **for ad-hoc human interaction only** (diagnostics, manual adjustments) and must not be used as part of autonomous order processing.

**Read-only (safe to use for reporting):**
```bash
node scripts/db-query.js get-paper-portfolio
node scripts/db-query.js get-paper-cash
node scripts/db-query.js get-paper-cash --chain <CHAIN>
node scripts/db-query.js get-paper-positions
node scripts/db-query.js get-paper-positions --status open
node scripts/db-query.js get-paper-positions --symbol TOKEN
node scripts/db-query.js get-paper-receipts
node scripts/db-query.js get-paper-receipts --limit 10
node scripts/db-query.js get-paper-stats
```

**Mutations (human interaction only — never during heartbeat):**
- `set-paper-cash --chain <CHAIN> --amount <N>`.
- `add-paper-position --json '<Position+value_usd>'` — auto-deducts from `paper_cash`, auto-computes `quantity`.
- `update-paper-position --id <ID> --json '{current_price, value_usd?}'`.
- `close-paper-position --id <ID> [--quantity <N>] --json '{exit_price, exit_reason}'` — auto-credits sale proceeds to `paper_cash`.
- `add-paper-receipt --json '<Receipt+tier+proposed_price+quantity+amount>'`.

### Portfolio Sync (On-Chain — Real Mode Only)
```bash
node scripts/db-query.js sync-portfolio --chain <CHAIN>
node scripts/db-query.js sync-portfolio --chain <CHAIN> --trigger post_trade
node scripts/db-query.js get-sync-status
node scripts/db-query.js get-sync-status --chain <CHAIN>
node scripts/db-query.js set-onchain-balance --id <position_id> --balance 1000.5
```

## Trade Execution (Real Mode Only)

### EVM (Safe Wallet) — execute-trade-evm.js

All EVM chains use the same Safe + 1inch stack.

```bash
node scripts/execute-trade-evm.js --action buy --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount 500 --max-slippage 5 --tier moonshot --deadline 300
node scripts/execute-trade-evm.js --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount all --max-slippage 5
node scripts/execute-trade-evm.js --action sell --chain <CHAIN> --address 0xTOKEN --symbol TOKEN --amount 10000 --max-slippage 2 --deadline 300
```
Handles: 1inch swap quoting, ERC-20 approvals, Safe multi-send, signing with `SAFE_SIGNER_KEY`.
Requires: `SAFE_ADDRESS_<CHAIN>`, `SAFE_SIGNER_KEY`, `RPC_<CHAIN>` per chain.

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
node scripts/check-safe-status.js --chain <CHAIN>
node scripts/check-safe-status.js --chain <CHAIN> --safe-hash 0xABC123...
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
node scripts/portfolio-load-evm.js --chain <CHAIN>
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger post_trade
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
# Alerts route to the correct Telegram supergroup topic automatically:
# trade_executed/trade_failed → Executor topic | model_failure/emergency_mode → Alerts topic | system_health → Observer topic | recovered → System topic
node scripts/send-alert.js --type trade_executed --agent executor --message "BUY executed: TOKEN"
node scripts/send-alert.js --type trade_failed --agent executor --message "Order fetch failed: <reason>"
node scripts/send-alert.js --type model_failure --agent executor --message "Agent failed"
node scripts/send-alert.js --type emergency_mode --agent executor --message "Emergency mode active"
node scripts/send-alert.js --type system_health --agent executor --message "log/heartbeat write failed: <reason>"
node scripts/send-alert.js --type recovered --agent executor --message "Back to normal"
```

Every successful `send-alert.js` invocation also writes an `[info] [send-alert]` entry to `/tmp/openclaw/system.log` — this is Observer's correlation signal for silent-crash detection. When you fire an alert after a failure, Observer sees the system.log line near the matching `status:"error"` log row and knows the agent self-reported (no GitHub issue). If the log row has no matching send-alert line nearby, Observer treats it as a silent crash.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `ACTIVE_CHAINS` | Per `get-chains` | Comma-separated list of active chains. Run `get-chains` to see available chains. |
| `PAPER_MODE` | `false` | Enable simulated trading (no real transactions, no on-chain sync) |

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
