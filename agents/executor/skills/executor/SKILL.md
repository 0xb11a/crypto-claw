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
Read pending orders. Validate. Build Safe transactions. Sign. Submit. Record receipts. That's it.

## Process (Every Heartbeat)

### Step 1: Load Pending Orders
```bash
# Sell orders first (urgent)
cat memory/sell-orders.json

# Then approved buys
cat memory/approved-trades.json

# Current positions for validation
cat memory/portfolio-state.json
```

If no unexecuted orders → HEARTBEAT_OK, done.

### Step 2: Validate Each Order

For SELL orders, check:
- Position exists in portfolio-state.json
- Token address matches
- Sell amount ≤ position quantity

For BUY orders, check:
- `approved: true` is set
- Position size within tier limits
- Cash balance sufficient
- Current price within 10% of proposed entry

If validation fails → write FAILED receipt, mark order `executed: true` with `status: "validation_failed"`, alert human.

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

Write to `memory/trade-receipts.json`:
```json
{
  "id": "receipt-uuid",
  "orderId": "source-order-id",
  "orderSource": "sell-orders",
  "timestamp": "ISO-8601",
  "action": "sell",
  "symbol": "TOKEN",
  "chain": "base",
  "status": "executed",
  "safeTxHash": "0x...",
  "onchainTxHash": "0x...",
  "executedPrice": 0.00098,
  "slippage": 0.02
}
```

### Step 5: Update State

If trade executed on-chain:
- BUY: add position to portfolio-state.json, reduce cash
- SELL all: remove position, add proceeds to cash
- SELL partial: reduce quantity, add proceeds to cash

Mark source order as `executed: true` with `executedAt` timestamp.

### Step 6: Notify

- Executed → inform human (non-urgent): "Sold 100% of $TOKEN at $0.00098"
- Queued in Safe → inform human: "Trade signed, needs X more signature(s) in Safe"
- Failed → alert human (urgent): "SELL $TOKEN failed: [reason]"
