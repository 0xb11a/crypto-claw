# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. Keep processing fast and mechanical.

## Procedure

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
cclaw alerts send --type trade_failed --agent executor --message "order fetch failed: <reason>"
```
Observer correlates the `status: "error"` executor_log row with the `trade_failed` alert. Both are required. Then end the cycle. (See AGENTS.md § Error Self-Reporting.)

### Step 2: Execute each order

For **each** order (sells first, then buys), call:
```bash
cclaw orders execute --id ORDER_ID
```

A 202 response means the order has been **enqueued** in the BullMQ job queue. The `ExecuteOrderProcessor` (NestJS worker) picks it up within seconds and runs the full lifecycle atomically:
- Validates (cash, price, position)
- Executes (routes to the correct chain — Safe EVM or Squads Solana)
- Writes receipt (linked to position via `position_id`)
- Creates/closes position (or `draft`/`pending_exit` for queued multisig)
- Updates cash
- Marks order executed or failed
- Sends alert notification (structured log entry)

**You do NOT need to run any other commands for order processing.** The processor does everything.

**Verify on next 1-minute cycle:** after enqueuing, poll status on your subsequent heartbeat via:
```bash
cclaw orders get --id ORDER_ID
```
Status will progress to `executed` / `failed` / `rejected`. Sentinel may see positions in `draft` or `pending_exit` mid-cycle — this is expected while multisig approval is pending.

**Report "enqueued N orders" not "executed N orders" per cycle.** Execution confirmation arrives on the next heartbeat.

**If `cclaw orders execute` returns 4xx/5xx or no response:**
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":0,"buy_orders_processed":0,"success_count":0,"fail_count":1,"status":"error"}'
```
(legacy hold-back)
```bash
cclaw alerts send --type trade_failed --agent executor --message "execute enqueue failed for order <ID>: <reason>"
```

**Queued multisig transactions** (status `queued_in_safe` / `queued_in_squads`) are tracked by the MultisigTrackerProcessor (NestJS worker, every 5 min) — you don't handle them.

### Step 3: Log + done
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":N,"buy_orders_processed":N,"success_count":N,"status":"ok"}'
```
(legacy hold-back)
```bash
cclaw heartbeat ping --agent executor --check process_orders
```

**If `add-executor-log` or `cclaw heartbeat ping` fails:** this is a critical condition — a stuck heartbeat masquerades as a healthy cycle and Observer's dead-agent detection relies on these timestamps. Fire `cclaw alerts send --type system_health --agent executor --message "log/heartbeat write failed: <reason>"`. Observer's audit log provides the correlation signal.

Report results: list each order enqueued, their current status (from Step 1 poll or next-cycle check), and any errors.

## Rules
- Process sell orders BEFORE buy orders — every heartbeat
- **Use `cclaw orders execute --id X` for all order processing.** Do NOT manually construct receipt/position/cash commands.
- If `cclaw orders execute` returns non-202, report the error and log it.
- Report every enqueue in your reply — the order ID and 202 acknowledgement proves work was done.
- Confirm execution status on subsequent heartbeats via `cclaw orders get --id ORDER_ID` — status will progress to `executed` / `failed` / `rejected`.
