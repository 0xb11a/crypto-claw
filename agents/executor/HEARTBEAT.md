# HEARTBEAT.md — Executor Agent

## Schedule
Executor heartbeat runs every 1 minute. Keep processing fast and mechanical.

## Procedure

### Step 0: Detect mode
```bash
echo "PAPER_MODE=${PAPER_MODE:-false}"
```
If `PAPER_MODE=false` AND no `SAFE_SIGNER_KEY` env var → alert human, reply HEARTBEAT_OK.

### Step 1: Load pending orders (sells first)
```bash
node scripts/db-query.js get-orders --pending --action sell
node scripts/db-query.js get-orders --pending --action buy --approved
```
If both empty → reply HEARTBEAT_OK.

### Step 2: Process each SELL order

**2a. Validate** (see AGENTS.md validation rules):
```bash
# Real mode:
node scripts/db-query.js get-positions --symbol TOKEN
# Paper mode:
node scripts/db-query.js get-paper-positions --symbol TOKEN
```

**2b. Validation fails →**
```bash
node scripts/db-query.js add-receipt --json '{"order_id":"...","action":"sell","symbol":"TOKEN","chain":"...","status":"validation_failed","error":"..."}'
node scripts/db-query.js mark-order-executed --id ORDER_ID
```

**2c. Determine sell quantity from order's `amount` field:**
- `"all"` → full sell (entire position)
- `"50%"` or any `N%` → partial sell: `sell_qty = position.quantity * N / 100`

**2d. PAPER_MODE=true →**

Full sell (`amount` is `"all"`):
```bash
node scripts/db-query.js add-paper-receipt --json '{"id":"paper-<ts>","order_id":"...","action":"sell","symbol":"TOKEN","address":"0x...","chain":"base","proposed_price":0.001,"quantity":10000,"amount":500}'
node scripts/db-query.js close-paper-position --id POS_ID --json '{"exit_price":0.001,"exit_reason":"stop_loss"}'
node scripts/db-query.js mark-order-executed --id ORDER_ID
```

Partial sell (`amount` is `"50%"` etc.):
```bash
node scripts/db-query.js add-paper-receipt --json '{"id":"paper-<ts>","order_id":"...","action":"sell","symbol":"TOKEN","address":"0x...","chain":"base","proposed_price":0.001,"quantity":SELL_QTY,"amount":PARTIAL_USD}'
node scripts/db-query.js close-paper-position --id POS_ID --quantity SELL_QTY --json '{"exit_price":0.001,"exit_reason":"tp1_hit"}'
node scripts/db-query.js mark-order-executed --id ORDER_ID
```
Where `SELL_QTY = position.quantity * percent / 100` and `PARTIAL_USD = SELL_QTY * exit_price`.

**2e. PAPER_MODE=false →**

Determine `--amount` flag from order:
- `"all"` → `--amount all`
- `"50%"` → calculate `sell_qty = position.quantity * 50 / 100`, pass `--amount <sell_qty>`

```bash
# EVM:
node scripts/execute-trade.js --action sell --symbol TOKEN --address 0x... --chain base --amount <AMOUNT> --max-slippage 5
# Solana:
node scripts/execute-trade-solana.js --action sell --symbol TOKEN --address MINT --chain solana --amount <AMOUNT> --max-slippage 5
```
Parse JSON stdout. Branch on `status`:
- `"executed"`:
  - Full sell → `add-receipt` → `close-position --id X --json '{"exit_price":...,"exit_reason":"..."}'` → `mark-order-executed` → `portfolio-load-evm.js --chain X --trigger post_trade` (or `portfolio-load-solana.js` for Solana)
  - Partial sell → `add-receipt` → `close-position --id X --quantity SOLD_QTY --json '{"exit_price":...,"exit_reason":"..."}'` → `mark-order-executed` → portfolio sync
- `"queued_in_safe"` or `"queued_in_squads"` → `add-receipt` with queued status (include `safe_tx_hash`/`squads_transaction_index`) → `mark-order-executed` → notify human. Do NOT update positions/cash.
- `"failed"` → `add-receipt` with `status: "tx_failed"`, include error details in the `"error"` field → `mark-order-executed` → alert human

### Step 3: Process each BUY order

**3a. Validate:** `approved=1`, cash sufficient, price within 10% of proposal.
```bash
# Cash check:
# Real mode:
node scripts/db-query.js get-cash --chain CHAIN
# Paper mode:
node scripts/db-query.js get-paper-cash --chain CHAIN

# Price check (stale order protection):
node scripts/token-metrics.js --address TOKEN_ADDRESS --chain CHAIN
```
Parse `token-metrics.js` output → extract current price. If price has drifted >10% from the order's `entry_price` → validation fails (stale order). Use the fetched price as `current_price` when recording the position.

**3b. Validation fails →** same as 2b.

**3c. PAPER_MODE=true →**
Use the current price fetched in 3a (not the proposed price) as `entry_price` and `current_price` for the paper position. The receipt keeps `proposed_price` for audit trail. Recalculate `quantity` as `amount / current_price`.
```bash
node scripts/db-query.js add-paper-receipt --json '{"id":"paper-<ts>","order_id":"...","action":"buy","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","proposed_price":0.001,"quantity":10000,"amount":500}'
node scripts/db-query.js add-paper-position --json '{"id":"pos-<ts>","symbol":"TOKEN","address":"0x...","chain":"base","tier":"moonshot","entry_price":CURRENT_PRICE,"current_price":CURRENT_PRICE,"quantity":AMOUNT/CURRENT_PRICE,"value_usd":500,"stop_loss":0.0005,"take_profit_levels":"[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]","status":"open"}'
node scripts/db-query.js mark-order-executed --id ORDER_ID
```

**3d. PAPER_MODE=false →**
```bash
# EVM:
node scripts/execute-trade.js --action buy --symbol TOKEN --address 0x... --chain base --amount 500 --max-slippage 5
# Solana:
node scripts/execute-trade-solana.js --action buy --symbol TOKEN --address MINT --chain solana --amount 500 --max-slippage 5
```
Parse JSON stdout. Branch on `status`:
- `"executed"` → `add-receipt` → `add-position --json '{...}'` → `set-cash --chain X --amount NEW` → `mark-order-executed` → `portfolio-load-evm.js --chain X --trigger post_trade` (or `portfolio-load-solana.js`)
- `"queued_in_safe"` or `"queued_in_squads"` → `add-receipt` with queued status → `mark-order-executed` → notify human. Do NOT update positions/cash.
- `"failed"` → `add-receipt` with `status: "tx_failed"` → `mark-order-executed` → alert human

### Step 4: Check queued transactions (real mode only — skip if paper)
```bash
node scripts/db-query.js get-receipts --status queued_in_safe
node scripts/db-query.js get-receipts --status queued_in_squads
```
For each queued receipt:
```bash
# EVM:
node scripts/check-safe-status.js --chain CHAIN --safe-hash HASH
# Solana:
node scripts/check-squads-status.js --pending
```
If confirmed on-chain → update receipt to `executed`, update positions/cash, trigger portfolio sync.

### Step 5: Log + done
```bash
node scripts/db-query.js add-executor-log --json '{"sell_orders_processed":N,"buy_orders_processed":N,"success_count":N,"status":"ok"}'
node scripts/db-query.js update-heartbeat --agent executor --check process_orders
```

## Rules
- Process sell orders BEFORE buy orders — every heartbeat
- **Only use `node scripts/db-query.js` for database access. Never use `sqlite3` or any other database tool.**
- Every order MUST result in: receipt + mark-order-executed. Never silently skip an order.
- If a trade fails, record the failure and alert — never retry automatically
