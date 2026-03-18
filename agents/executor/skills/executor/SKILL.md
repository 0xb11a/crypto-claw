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

**IMPORTANT: Check `PAPER_MODE` env var at the start of every cycle.** If `true`, use paper commands throughout. If `false` or unset, use real commands.

### Step 1: Load Pending Orders

```bash
# Sell orders first (urgent — written by Sentinel)
node scripts/db-query.js get-sell-orders --pending

# Then approved buys (written by Research after human approval)
node scripts/db-query.js get-approved-trades --pending

# Current positions for validation
#   Real mode:  node scripts/db-query.js get-positions
#   Paper mode: node scripts/db-query.js get-paper-positions
```

If no pending orders → HEARTBEAT_OK, done.

### Step 2: Validate Each Order

For SELL orders, check:
- Position exists in the database
- Token address matches
- Sell amount ≤ position quantity

```bash
# Verify position exists
#   Real mode:  node scripts/db-query.js get-positions --symbol TOKEN
#   Paper mode: node scripts/db-query.js get-paper-positions --symbol TOKEN
```

For BUY orders, check:
- `approved: 1` is set in the database
- Position size within tier limits
- Cash balance sufficient
- Current price within 10% of proposed entry

```bash
# Check cash balance
#   Real mode:  node scripts/db-query.js get-portfolio
#   Paper mode: node scripts/db-query.js get-paper-cash
```

If validation fails → write FAILED receipt, mark order as executed with `status: "validation_failed"`, alert human. **Do NOT call add-paper-trade for failed validations** — only add-receipt.

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

### Step 3: Execute (branching on PAPER_MODE)

#### If PAPER_MODE=true — Simulate execution

Do NOT call execute-trade.js or interact with the Safe wallet. Instead:

```bash
# Record paper trade
node scripts/db-query.js add-paper-trade --json '{
  "id": "paper-<timestamp>",
  "order_id": "<original-order-id>",
  "order_source": "approved_trades",
  "action": "buy",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "proposed_price": 0.001,
  "quantity": 10000,
  "amount": 500
}'

# BUY: create paper position + reduce paper cash
node scripts/db-query.js add-paper-position --json '{
  "id": "pos-<timestamp>",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "tier": "moonshot",
  "entry_price": 0.001,
  "current_price": 0.001,
  "quantity": 10000,
  "value_usd": 500,
  "stop_loss": 0.0005,
  "take_profit_levels": "[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]",
  "status": "open"
}'
# Cash is auto-deducted from paper_cash by add-paper-position

# SELL: close paper position (cash auto-updated with sale proceeds)
node scripts/db-query.js close-paper-position --id <position-id> --json '{"exit_price": 0.002, "exit_reason": "stop_loss"}'
```

#### If PAPER_MODE=false (or unset) — Real execution

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

```bash
# Real mode: write to trade_receipts
node scripts/db-query.js add-receipt --json '{
  "order_id": "trade-...",
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

# Paper mode: already recorded via add-paper-trade in Step 3 — skip this step
```

### Step 5: Update State

**Paper mode:** Already done in Step 3 (add-paper-position / close-paper-position auto-manage cash). Skip to marking the order.

**Real mode only** (paper mode already handled in Step 3):

For BUY:
```bash
node scripts/db-query.js add-position --json '{...}'
node scripts/db-query.js set-cash --amount <new_amount>
```

For SELL ALL:
```bash
node scripts/db-query.js remove-position --id <id>
node scripts/db-query.js set-cash --amount <new_amount>
```

For SELL PARTIAL:
```bash
node scripts/db-query.js update-position --id <id> --json '{"quantity":<new_qty>,"status":"partial_exit"}'
node scripts/db-query.js set-cash --amount <new_amount>
```

### Step 5b: Post-Trade Portfolio Sync (real mode only)

After a successful trade execution in real mode, sync on-chain portfolio state:
```bash
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger post_trade
```
This ensures DB positions reflect actual on-chain balances after the trade. Skip in paper mode.

### Step 6: Mark Order Executed (both modes)

```bash
# For sell orders
node scripts/db-query.js update-sell-order --id "order-id" --status executed

# For approved trades
node scripts/db-query.js update-approved-trade --id "trade-id" --status executed
```

### Step 7: Notify

- Executed → inform human (non-urgent): "Sold 100% of $TOKEN at $0.00098"
- Paper mode → log: "Paper trade: bought $TOKEN at $0.001, $500"
- Queued in Safe → inform human: "Trade signed, needs X more signature(s) in Safe"
- Failed → alert human (urgent): "SELL $TOKEN failed: [reason]"

## Rules
- Executor ONLY reads from the database — it never creates orders itself
- Sell orders (from Sentinel) take priority over buy orders (from Research)
- If a trade fails, record the failure and alert — never retry automatically
- All state lives in the database — never write to JSON files
- Keep execution fast — the Executor agent runs on a 1-minute heartbeat

## Paper Mode Summary

When `PAPER_MODE=true`, the entire workflow above applies — but Steps 3-5 use paper commands instead of Safe wallet operations. The branching is built into Steps 3-5 above. Key rule: **never call execute-trade.js or interact with the Safe wallet in paper mode.**
