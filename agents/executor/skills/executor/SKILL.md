---
name: executor
description: Safe wallet transaction builder, signer, and submitter
triggers:
  - execute trade
  - sign transaction
  - process orders
  - submit to safe
---

# Executor Skill

## Purpose
Read pending orders from the database. Validate. Build Safe transactions. Sign. Submit. Record receipts. That's it.

## Process (Every Heartbeat)

### Step 1: Load Pending Orders

```bash
# Sell orders first (urgent — written by Sentinel)
node scripts/db-query.js get-sell-orders --pending

# Then approved buys (written by Research after human approval)
node scripts/db-query.js get-approved-trades --pending

# Current positions for validation
node scripts/db-query.js get-positions
```

If no pending orders → HEARTBEAT_OK, done.

### Step 2: Validate Each Order

For SELL orders, check:
- Position exists in the database
- Token address matches
- Sell amount ≤ position quantity

```bash
# Verify position exists
node scripts/db-query.js get-positions --symbol TOKEN
```

For BUY orders, check:
- `approved: 1` is set in the database
- Position size within tier limits
- Cash balance sufficient
- Current price within 10% of proposed entry

```bash
# Check current portfolio summary for cash balance
node scripts/db-query.js get-portfolio
```

If validation fails → write FAILED receipt, mark order as executed with `status: "validation_failed"`, alert human.

```bash
node scripts/db-query.js add-receipt --json '{
  "order_id": "trade-...",
  "order_source": "sell_orders",
  "action": "sell",
  "symbol": "TOKEN",
  "chain": "base",
  "status": "validation_failed",
  "failure_reason": "position not found"
}'
```

### Step 3: Build and Sign Transaction
```bash
# Execute the trade through Safe
node scripts/execute-trade.js \
  --action sell \
  --symbol TOKEN \
  --address 0x... \
  --chain base \
  --amount all \
  --max-slippage 5
```

The script handles:
1. Getting a swap quote (1inch / 0x / Jupiter)
2. Building Safe transaction data
3. Signing with SAFE_SIGNER_KEY
4. Submitting to Safe Transaction Service
5. Returning tx hash and status

### Step 4: Record Receipt

Write the execution result to the database:

```bash
node scripts/db-query.js add-receipt --json '{
  "order_id": "trade-1709712000",
  "order_source": "sell_orders",
  "action": "sell",
  "symbol": "TOKEN",
  "chain": "base",
  "status": "executed",
  "safe_tx_hash": "0x...",
  "onchain_tx_hash": "0x...",
  "executed_price": 0.00098,
  "slippage": 0.02
}'
```

Check recent receipts:
```bash
node scripts/db-query.js get-receipts --limit 5
```

### Step 5: Update State

After successful execution, update the position in the database:

For BUY:
```bash
node scripts/db-query.js update-position --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "buy",
  "quantity": 50000,
  "entry_price": 0.001,
  "tier": "moonshot"
}'
```

For SELL ALL:
```bash
node scripts/db-query.js update-position --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "close",
  "exit_price": 0.00098,
  "realized_pnl": -0.0001
}'
```

For SELL PARTIAL:
```bash
node scripts/db-query.js update-position --json '{
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "reduce",
  "sell_percent": 50,
  "exit_price": 0.002,
  "realized_pnl": 0.05
}'
```

Mark the source order as executed:
```bash
# For sell orders
node scripts/db-query.js update-sell-order --id "order-id" --status executed

# For approved trades
node scripts/db-query.js update-approved-trade --id "trade-id" --status executed
```

### Step 6: Notify

- Executed → inform human (non-urgent): "Sold 100% of $TOKEN at $0.00098"
- Queued in Safe → inform human: "Trade signed, needs X more signature(s) in Safe"
- Failed → alert human (urgent): "SELL $TOKEN failed: [reason]"

## Rules
- Executor ONLY reads from the database — it never creates orders itself
- Sell orders (from Sentinel) take priority over buy orders (from Research)
- If a trade fails, record the failure and alert — never retry automatically
- All state lives in the database — never write to JSON files
- Keep execution fast — the Executor agent runs on a 1-minute heartbeat
