# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. ALL checks run every heartbeat.
This agent runs on Ollama Cloud (DeepSeek). Keep processing fast and mechanical.

## Every Heartbeat — Run ALL:

**Check `PAPER_MODE` env var at the start.** If `true`, use paper commands and skip Safe wallet steps. See executor SKILL.md for full paper mode branching.

### 1. Process Sell Orders (PRIORITY — always first)
```bash
node scripts/db-query.js get-sell-orders --pending
```
For each pending order:
1. Validate: position exists in DB (use `get-paper-positions` if paper mode), address matches, amount valid
2. **If paper mode:** simulate at current price → `add-paper-trade` → `close-paper-position` (auto-updates cash) → mark order executed
3. **If real mode:** get swap quote → check slippage → build Safe tx → sign → submit
4. Write receipt: `add-receipt` (real) or already recorded via `add-paper-trade` (paper)
5. If executed: update position/cash, mark order executed
6. If queued in Safe (real mode only): write receipt with `queued_in_safe`, notify human
7. If failed: write receipt with error, alert human

### 2. Process Approved Trades
```bash
node scripts/db-query.js get-approved-trades --pending
```
For each pending trade:
1. Validate: `approved=1`, within tier limits, cash sufficient (use `get-paper-cash` if paper mode), price within 10%
2. **If paper mode:** simulate → `add-paper-trade` → `add-paper-position` (auto-deducts cash) → mark executed
3. **If real mode:** get swap quote → check slippage → build Safe tx → sign → submit
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
- If `SAFE_SIGNER_KEY` env var is missing AND `PAPER_MODE` is not `true` → log error, skip all execution, alert human
- If RPC endpoint is down → log error, retry next heartbeat, alert human after 3 consecutive failures
- If no pending orders → reply HEARTBEAT_OK immediately
- Keep total response under 300 tokens when nothing to process
