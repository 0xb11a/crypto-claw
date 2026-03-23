---
name: orders
description: View, approve, reject, cancel, and retry trade orders via chat
triggers:
  - pending orders
  - show orders
  - approve
  - reject
  - cancel order
  - retry order
  - order history
  - order status
  - what needs approval
---

# Orders Skill

## Purpose
Give humans full control over trade orders via chat. List pending orders, approve or reject proposals, cancel approved orders, retry failed sells, and review order history.

## Commands Reference

```bash
# List pending orders (buys awaiting approval + approved awaiting execution)
node scripts/db-query.js get-orders --pending --action buy
node scripts/db-query.js get-orders --pending --action sell

# Single order detail
node scripts/db-query.js get-order --id <id>

# Approve a pending buy order
node scripts/db-query.js approve-order --id <id> --by human

# Reject a pending order (never approved — bad idea)
node scripts/db-query.js reject-order --id <id> --reason "<reason>" --by human

# Cancel an approved or failed order (was approved, changed mind)
node scripts/db-query.js cancel-order --id <id> --reason "<reason>" --by human

# Retry a failed sell order (re-queue for execution)
node scripts/db-query.js retry-order --id <id> --by human

# Order history (all statuses)
node scripts/db-query.js get-order-history --limit 20
node scripts/db-query.js get-order-history --status rejected --limit 10
```

## State Machine

Orders follow a strict state machine. Use the correct command for each transition:

```
pending  --> approved    (approve-order)
pending  --> rejected    (reject-order)
approved --> executed    (Executor — automatic)
approved --> failed      (Executor — automatic)
approved --> cancelled   (cancel-order)
failed   --> approved    (retry-order, sells only)
failed   --> cancelled   (cancel-order)
```

- **reject** = order was never approved (human says "no" to the idea)
- **cancel** = order was approved but human changed their mind before execution
- Failed **buy** orders cannot be retried (price data is stale — create a new proposal)
- Failed **sell** orders can be retried (protective measure, urgency remains)

## Handling Human Messages

### "show pending" / "what's pending" / "orders"
1. Run `get-orders --pending --action buy` to get pending buys
2. Run `get-orders --pending --action sell` to get pending sells
3. Format as a compact list:

```
PENDING ORDERS

BUY:
  [buy-1711234567] $TOKEN on base — $500 (4% moonshot) — score: 76/100
  [buy-1711234590] $OTHER on solana — $200 (2% conviction) — score: 82/100

SELL:
  [sell-1711234600] $TOKEN on base — all (stop_loss_hit) — URGENT

2 buys awaiting approval, 1 sell queued
```

If no pending orders, say "No pending orders."

### "approve <id>" / "approve buy-001"
1. Run `get-order --id <id>` to show the order details
2. Display the full trade proposal (symbol, amount, tier, entry, stops, TPs, scores, reasoning)
3. Run `approve-order --id <id> --by human`
4. Confirm: "Approved. Executor will process on next cycle (~1 min)."
5. Show remaining pending count

### "approve all"
1. Run `get-orders --pending --action buy` to list all pending buys
2. List each order with key details
3. Ask: "Confirm approving N orders? Reply YES to proceed."
4. On YES: approve each order one by one, report results
5. On anything else: "Cancelled. No orders approved."

### "reject <id>" / "reject buy-001 too risky"
1. Run `reject-order --id <id> --reason "<reason>" --by human`
2. Confirm: "Rejected [id] — reason: <reason>"

### "cancel <id>"
1. Run `cancel-order --id <id> --reason "<reason>" --by human`
2. Confirm: "Cancelled [id] — reason: <reason>"

### "retry <id>"
1. Verify it's a sell order (buys cannot be retried)
2. Run `retry-order --id <id> --by human`
3. Confirm: "Retried [id] — re-queued for execution."

### "order history" / "recent orders"
1. Run `get-order-history --limit 10`
2. Format as a table with id, action, symbol, status, and timestamp

## Safety Rules
- NEVER auto-approve orders without explicit human instruction
- ALWAYS show order details before approving
- For "approve all", require explicit YES confirmation
- Terminal states (rejected, cancelled, executed, expired) cannot be changed
- If human tries an invalid transition, explain the correct command to use
