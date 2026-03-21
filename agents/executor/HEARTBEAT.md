# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. ALL checks run every heartbeat.
Keep processing fast and mechanical.

## Every Heartbeat — Run ALL:

**Run `echo "PAPER_MODE=${PAPER_MODE:-false}"` at the start.** Read the output. If `true`, use paper commands and skip Safe wallet steps. Reference this throughout — do not rely on memory from previous heartbeats. See executor SKILL.md for full execution flow (paper mode branching AND real mode script calls).

### 1. Process Sell Orders (PRIORITY — always first)
```bash
node scripts/db-query.js get-orders --pending --action sell
```
For each pending order:
1. Validate: position exists in DB (use `get-paper-positions` if paper mode), address matches, amount valid
2. **If paper mode:** simulate at current price → `add-paper-receipt` → `close-paper-position` (auto-updates cash) → mark order executed
3. **If real mode:** run `node scripts/execute-trade.js` (EVM) or `node scripts/execute-trade-solana.js` (Solana) with order params → capture JSON output → branch on `status` field. See SKILL.md Step 3 for exact flags, output format, and branching rules.
4. Write receipt: `add-receipt` (real) or already recorded via `add-paper-receipt` (paper)
5. If executed: update position/cash, mark order executed
6. If queued in Safe/Squads (real mode only): write receipt with queued status, mark order executed, notify human. Do NOT update positions/cash.
7. If failed: write receipt with error, alert human

### 2. Process Approved Trades
```bash
node scripts/db-query.js get-orders --pending --action buy --approved
```
For each pending trade:
1. Validate: `approved=1`, within tier limits, cash sufficient (use `get-paper-cash` if paper mode), price within 10%
2. **If paper mode:** simulate → `add-paper-receipt` → `add-paper-position` (auto-deducts cash) → mark executed
3. **If real mode:** run `node scripts/execute-trade.js` (EVM) or `node scripts/execute-trade-solana.js` (Solana) with order params → capture JSON output → branch on `status` field. See SKILL.md Step 3 for exact flags, output format, and branching rules.
4. Write receipt/update state as appropriate

### 3. Check Pending Transactions (real mode only)
```bash
# Skip this step entirely if PAPER_MODE=true
node scripts/db-query.js get-receipts --status queued_in_safe
```
For receipts with `queued_in_safe`:
1. Check Safe Transaction Service for status update
2. If now executed → update receipt, update portfolio state
3. If expired/cancelled → update receipt, alert human

### 4. Log Results
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":0,"buy_orders_processed":0,"success_count":0,"status":"ok"}'
node scripts/db-query.js update-heartbeat --agent executor --check process_orders
```

## Rules
- Process sell orders BEFORE buy orders — every single heartbeat
- **Only use `node scripts/db-query.js` for database access. Never use `sqlite3` or any other database tool.**
- If `SAFE_SIGNER_KEY` env var is missing AND `PAPER_MODE` is not `true` → log error, skip all execution, alert human
- If RPC endpoint is down → log error, retry next heartbeat, alert human after 3 consecutive failures
- If no pending orders → reply HEARTBEAT_OK immediately
- Keep total response under 300 tokens when nothing to process
