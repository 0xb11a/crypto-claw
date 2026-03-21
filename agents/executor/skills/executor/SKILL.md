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

### Step 0: Load Configuration (MANDATORY — run before anything else)
```bash
echo "=== EXECUTOR CONFIG ==="
echo "PAPER_MODE=${PAPER_MODE:-false}"
echo "ACTIVE_CHAINS=${ACTIVE_CHAINS:-base}"
echo "======================"
```
Read the output. This determines your execution path for the entire cycle:
- `PAPER_MODE=true` → paper DB commands, skip Safe/Squads wallet operations
- `PAPER_MODE=false` → real DB commands, execute through Safe/Squads
Reference this output throughout. Do not rely on memory of previous cycles.

### Step 1: Load Pending Orders

```bash
# Sell orders first (urgent — written by Sentinel)
node scripts/db-query.js get-orders --pending --action sell

# Then approved buys (written by Research after human approval)
node scripts/db-query.js get-orders --pending --action buy --approved

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
- `approved: 1` is set in the database. If a BUY order has `approved: 0`, skip it with explanation: "Skipping [ORDER-ID]: awaiting human approval". Do NOT write a validation_failed receipt — the order is not failed, just pending.
- Position size within tier limits
- Cash balance sufficient
- Current price within 10% of proposed entry

```bash
# Check cash balance (per-chain)
#   Real mode:  node scripts/db-query.js get-cash --chain <chain>
#   Paper mode: node scripts/db-query.js get-paper-cash --chain <chain>
```

If validation fails → write FAILED receipt, mark order as executed with `status: "validation_failed"`, alert human. **Do NOT call add-paper-receipt for failed validations** — only add-receipt.

```bash
node scripts/db-query.js add-receipt --json '{
  "order_id": "trade-...",
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
node scripts/db-query.js add-paper-receipt --json '{
  "id": "paper-<timestamp>",
  "order_id": "<original-order-id>",
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

**Run the execution script** for the order's chain. This single command handles swap quoting, transaction building, signing, and submission — you do NOT perform these steps manually:

```bash
# EVM chains (Base, etc.) — Execute through Safe
node scripts/execute-trade.js \
  --action sell \
  --symbol TOKEN \
  --address 0x... \
  --chain base \
  --amount all \
  --max-slippage 5

# Solana — Execute through Squads multisig via Jupiter
node scripts/execute-trade-solana.js \
  --action sell \
  --symbol TOKEN \
  --address <mint_address> \
  --chain solana \
  --amount all \
  --max-slippage 5
```

Both scripts print JSON to stdout. **You MUST capture and parse this output** — it contains the execution result. The script always prints JSON to stdout, even on failure (exit code 1). Capture stdout regardless of exit code.

**EVM output fields:** `status`, `safeHash`, `txHash`, `action`, `symbol`, `chain`, `tokenAddress`, `usdcSpent`, `expectedTokens`, `tokensSold`, `expectedUsdc`, `error`, `timestamp`
**Solana output fields:** `status`, `txSignature`, `squadsTransactionIndex`, plus same trade fields (`action`, `symbol`, `chain`, `tokenAddress`, `usdcSpent`, `expectedTokens`, `tokensSold`, `expectedUsdc`, `error`, `timestamp`)

**Branch on the `status` field:**

- `status: "executed"` → proceed to Step 4 (receipt with full data from output) → Step 5 (update positions/cash) → Step 6 (mark order executed) → Step 7 (notify human)
- `status: "queued_in_safe"` or `status: "queued_in_squads"` → Step 4 (receipt with queued status, include `safeHash`/`squadsTransactionIndex`) → Step 6 (mark order executed to prevent reprocessing) → Step 7 (notify human that more signatures are needed). Do NOT update positions or cash — funds haven't moved yet.
- `status: "failed"` → Step 4 (receipt with `status: "tx_failed"`, include `error` field from output in `failure_reason`) → Step 6 (mark order executed) → Step 7 (alert human)

### Step 4: Record Receipt

```bash
# Real mode: write to receipts
node scripts/db-query.js add-receipt --json '{
  "order_id": "trade-...",
  "action": "sell",
  "symbol": "TOKEN",
  "chain": "base",
  "status": "executed",
  "safe_tx_hash": "0x...",
  "onchain_tx_hash": "0x...",
  "executed_price": 0.00098,
  "slippage": 0.02
}'

# Paper mode: already recorded via add-paper-receipt in Step 3 — skip this step
```

### Step 5: Update State

**Paper mode:** Already done in Step 3 (add-paper-position / close-paper-position auto-manage cash). Skip to marking the order.

**Real mode only** (paper mode already handled in Step 3):

For BUY:
```bash
node scripts/db-query.js add-position --json '{...}'
node scripts/db-query.js set-cash --chain <chain> --amount <new_amount>
```

For SELL ALL (P&L auto-calculated, no set-cash needed — on-chain sync handles cash):
```bash
node scripts/db-query.js close-position --id <id> --json '{"exit_price": 0.002, "exit_reason": "stop_loss"}'
```

For SELL PARTIAL (P&L auto-calculated, no set-cash needed — on-chain sync handles cash):
```bash
node scripts/db-query.js close-position --id <id> --quantity <sold_qty> --json '{"exit_price": 0.002, "exit_reason": "take_profit_partial"}'
```

### Step 5b: Post-Trade Portfolio Sync (real mode only)

After a successful trade execution in real mode, sync on-chain portfolio state:
```bash
# EVM chains:
node scripts/portfolio-load-evm.js --chain <CHAIN> --trigger post_trade

# Solana:
node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
```
This ensures DB positions reflect actual on-chain balances after the trade. Skip in paper mode.

### Step 6: Mark Order Executed (both modes)

```bash
node scripts/db-query.js mark-order-executed --id "order-id"
```

### Step 7: Notify

- Executed → inform human (non-urgent): "Sold 100% of $TOKEN at $0.00098"
- Paper mode → log: "Paper trade: bought $TOKEN at $0.001, $500"
- Queued in Safe → inform human: "Trade signed, needs X more signature(s) in Safe"
- Failed → alert human (urgent): "SELL $TOKEN failed: [reason]"

## Queued Transaction Handling (Multisig Threshold > 1)

When `execute-trade.js` returns `queued_in_safe` or `execute-trade-solana.js` returns `queued_in_squads`, the transaction needs more signatures before it confirms on-chain. Handle this carefully:

1. **Record receipt with queued status** — write the receipt immediately with `status: "queued_in_safe"` or `status: "queued_in_squads"`. Include `safe_tx_hash`/`squads_transaction_index` so the transaction can be tracked.
2. **Do NOT update positions or cash** — the funds haven't moved yet. Do not call `add-position`, `remove-position`, `update-position`, `set-cash`, or any paper equivalents.
3. **Mark the order as executed** — so it isn't re-processed on the next heartbeat. The receipt's queued status tracks that it still needs confirmation.
4. **On subsequent heartbeats** — check for queued receipts and verify on-chain status:
   ```bash
   # Find queued receipts
   node scripts/db-query.js get-receipts --status queued_in_safe
   node scripts/db-query.js get-receipts --status queued_in_squads

   # Check if confirmed on-chain
   node scripts/check-safe-status.js --chain <chain> --safe-hash <safe_tx_hash>
   node scripts/check-squads-status.js --pending
   ```
5. **Once confirmed on-chain** — update the receipt status to `executed`, then proceed with position and cash updates as normal (Step 5 above). Trigger portfolio sync.

## Rules
- Executor ONLY reads from the database — it never creates orders itself
- Sell orders (from Sentinel) take priority over buy orders (from Research)
- If a trade fails, record the failure and alert — never retry automatically
- All state lives in the database — never write to JSON files
- Keep execution fast — the Executor agent runs on a 1-minute heartbeat
- **No silent completion:** Every order fetched MUST result in one of: (a) successful execution with receipt, (b) queued status with receipt and human notification, (c) failed status with receipt and human alert, (d) validation failure with receipt and explanation, or (e) explicit skip with reason logged. Never silently move past an order.

## Paper Mode Summary

When `PAPER_MODE=true`, the entire workflow above applies — but Steps 3-5 use paper commands instead of Safe wallet operations. The branching is built into Steps 3-5 above. Key rule: **never call execute-trade.js or interact with the Safe wallet in paper mode.**
