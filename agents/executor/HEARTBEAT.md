# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. ALL checks run every heartbeat.
This agent uses the cheapest model. Keep processing fast and mechanical.

## Every Heartbeat — Run ALL:

### 1. Process Sell Orders (PRIORITY — always first)
```bash
node scripts/db-query.js get-sell-orders --pending
```
For each pending order:
1. Validate: position exists in DB, address matches, amount is valid
2. Get swap quote from DEX aggregator
3. Check slippage (reject if >5% for moonshot, >2% for others)
4. Build Safe transaction, sign with `SAFE_SIGNER_KEY`, submit
5. Write receipt: `node scripts/db-query.js add-receipt --json '...'`
6. If executed on-chain: update position, update cash, mark order executed
7. If queued in Safe: write receipt with `queued_in_safe`, notify human
8. If failed: write receipt with error, alert human

### 2. Process Approved Trades
```bash
node scripts/db-query.js get-approved-trades --pending
```
For each pending trade:
1. Validate: `approved=1`, within tier limits, cash sufficient, price within 10% of proposal
2. Get swap quote, check slippage
3. Build Safe transaction, sign, submit
4. Write receipt, update state as appropriate

### 3. Check Pending Transactions
```bash
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
- If `SAFE_SIGNER_KEY` env var is missing → log error, skip all execution, alert human
- If RPC endpoint is down → log error, retry next heartbeat, alert human after 3 consecutive failures
- If no pending orders → reply HEARTBEAT_OK immediately
- Keep total response under 300 tokens when nothing to process
