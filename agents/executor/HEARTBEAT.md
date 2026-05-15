# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. Keep processing fast and mechanical.

## Procedure

`node scripts/process-order.js` owns the entire order lifecycle — validation, transaction handling, receipts, position writes, cash updates, and per-order failure modes (including `markFailed(..., 'no_signer_key')` when a chain's signer key is missing). Your job is to call it and report what it returns. (`process-order.js` is a legacy hold-back; a cclaw equivalent is pending P5.)

### Step 1: Load approved orders (sells first, then buys)
```bash
cclaw orders list --status approved --action sell
```
```bash
cclaw orders list --status approved --action buy
```
If both empty → reply HEARTBEAT_OK.

**If either call itself fails (API unreachable, exits non-zero, returns malformed JSON): do NOT reply HEARTBEAT_OK.** A silent failure looks identical to a quiet cycle — Observer cannot distinguish them unless you shout. Required on failure:
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":0,"buy_orders_processed":0,"success_count":0,"fail_count":0,"status":"error"}'
```
(legacy hold-back)
```bash
node scripts/send-alert.js --type trade_failed --agent executor --message "order fetch failed: <reason>"
```
(legacy hold-back) Observer correlates the `status: "error"` executor_log row with the `trade_failed` alert on system.log timestamps — both are required. Then end the cycle. (See AGENTS.md § Error Self-Reporting.)

### Step 2: Process each order with process-order.js

For **each** order (sells first, then buys), run:
```bash
node scripts/process-order.js --order-id ORDER_ID
```
(legacy hold-back)

The script handles the **entire lifecycle** atomically:
- Validates (cash, price, position)
- Executes (the script handles transaction routing and signing for the deployment)
- Writes receipt (linked to position via `position_id`)
- Creates/closes position (or creates `draft`/`pending_exit` for queued multisig)
- Updates cash
- Marks order executed or failed
- Sends alert notification

Parse the JSON output. Each result contains:
- `ok` — true if processed successfully
- `status` — "executed", "queued_in_safe", "queued_in_squads", or "failed"
- `receipt_id` — proof of execution
- `position_id` — the position created or affected
- `error` — reason if failed

**You do NOT need to run any other commands for order processing.** The script does everything. Queued multisig transactions are tracked by the MultisigTrackerProcessor (NestJS worker, every 5 min) — you don't handle them.

### Step 3: Log + done
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":N,"buy_orders_processed":N,"success_count":N,"status":"ok"}'
```
(legacy hold-back)
```bash
cclaw heartbeat ping --agent executor --check process_orders
```

**If `add-executor-log` or `cclaw heartbeat ping` fails:** this is a critical condition — a stuck heartbeat masquerades as a healthy cycle and Observer's dead-agent detection relies on these timestamps. Fire `node scripts/send-alert.js --type system_health --agent executor --message "log/heartbeat write failed: <reason>"` (legacy hold-back). The send-alert call logs to `/tmp/openclaw/system.log`, giving Observer the correlation signal.

Report results: list each order processed with its status, receipt ID, and any errors.

## Rules
- Process sell orders BEFORE buy orders — every heartbeat
- **Use `node scripts/process-order.js --order-id X` for all order processing.** Do NOT manually construct receipt/position/cash commands.
- If `process-order.js` returns `ok: false`, report the error. The script already marked the order as failed.
- Report every result in your reply — the receipt ID proves work was done.
