# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. Keep processing fast and mechanical.

## Procedure

### Step 0: Detect mode
```bash
echo "PAPER_MODE=${PAPER_MODE:-false}"
```
If `PAPER_MODE=false` AND no `SAFE_SIGNER_KEY` env var → alert human, reply HEARTBEAT_OK.

### Step 1: Load approved orders (sells first, then buys)
```bash
node scripts/db-query.js get-orders --status approved --action sell
node scripts/db-query.js get-orders --status approved --action buy
```
If both empty → reply HEARTBEAT_OK.

### Step 2: Process each order with process-order.js

For **each** order (sells first, then buys), run:
```bash
node scripts/process-order.js --order-id ORDER_ID
```

The script handles the **entire lifecycle** atomically:
- Validates (cash, price, position)
- Executes (calls execute-trade-evm.js or simulates in paper mode)
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

**You do NOT need to run any other commands for order processing.** The script does everything. Queued multisig transactions are tracked by the background `track-multisig.js` job — you don't handle them.

### Step 3: Log + done
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":N,"buy_orders_processed":N,"success_count":N,"status":"ok"}'
node scripts/db-query.js update-heartbeat --agent executor --check process_orders
```

Report results: list each order processed with its status, receipt ID, and any errors.

## Rules
- Process sell orders BEFORE buy orders — every heartbeat
- **Use `node scripts/process-order.js --order-id X` for all order processing.** Do NOT manually construct receipt/position/cash commands.
- **Only use `node scripts/db-query.js` for database queries.** Never use `sqlite3` or any other database tool.
- If `process-order.js` returns `ok: false`, report the error. The script already marked the order as failed.
- Report every result in your reply — the receipt ID proves work was done.
