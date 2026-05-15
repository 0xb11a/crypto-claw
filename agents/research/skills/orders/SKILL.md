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

Run one command per exec call. Pick the variant that matches the human's request.

List pending buys awaiting approval:
```bash
cclaw orders list --pending --action buy
```

List pending sells awaiting execution:
```bash
cclaw orders list --pending --action sell
```

Single order detail:
```bash
cclaw orders get --id <id>
```

Approve a pending buy order:
```bash
cclaw orders approve --id <id> --by human
```

Reject a pending order (never approved — bad idea):
```bash
cclaw orders reject --id <id> --reason "<reason>"
```

Cancel an approved or failed order (was approved, changed mind):
```bash
node scripts/db-query.js cancel-order --id <id> --reason "<reason>" --by human
```
(legacy hold-back — `cclaw orders cancel` pending P5)

Retry a failed sell order (re-queue for execution):
```bash
node scripts/db-query.js retry-order --id <id> --by human
```
(legacy hold-back — `cclaw orders retry` pending P5)

Order history (all statuses):
```bash
node scripts/db-query.js get-order-history --limit 20
```
(legacy hold-back)

Order history filtered by status:
```bash
node scripts/db-query.js get-order-history --status rejected --limit 10
```
(legacy hold-back)

## State Machine

Orders follow a strict state machine. Use the correct command for each transition:

```
pending  --> approved    (cclaw orders approve)
pending  --> rejected    (cclaw orders reject)
approved --> executed    (Executor — automatic)
approved --> failed      (Executor — automatic)
approved --> cancelled   (cancel-order legacy hold-back)
failed   --> approved    (retry-order legacy hold-back, sells only)
failed   --> cancelled   (cancel-order legacy hold-back)
```

- **reject** = order was never approved (human says "no" to the idea)
- **cancel** = order was approved but human changed their mind before execution
- Failed **buy** orders cannot be retried (price data is stale — create a new proposal)
- Failed **sell** orders can be retried (protective measure, urgency remains)

## Handling Human Messages

### "show pending" / "what's pending" / "orders"
1. Run `cclaw orders list --pending --action buy` to get pending buys
2. Run `cclaw orders list --pending --action sell` to get pending sells
3. Format as a compact list:

```
PENDING ORDERS

BUY:
  [buy-1711234567] $TOKEN on <CHAIN> — $500 (4% moonshot) — score: 76/100
  [buy-1711234590] $OTHER on <CHAIN> — $200 (2% conviction) — score: 82/100

SELL:
  [sell-1711234600] $TOKEN on <CHAIN> — all (stop_loss_hit) — URGENT

2 buys awaiting approval, 1 sell queued
```

If no pending orders, say "No pending orders."

### "approve <id>" / "approve buy-001"
1. Run `cclaw orders get --id <id>` to show the order details
2. Display the full trade proposal (symbol, amount, tier, entry, stops, TPs, scores, reasoning)
3. Run `cclaw orders approve --id <id> --by human`
4. Confirm: "Approved. Executor will process on next cycle (~1 min)."
5. Show remaining pending count

### "approve all"
1. Run `cclaw orders list --pending --action buy` to list all pending buys
2. List each order with key details
3. Ask: "Confirm approving N orders? Reply YES to proceed."
4. On YES: approve each order one by one, report results
5. On anything else: "Cancelled. No orders approved."

### "reject <id>" / "reject buy-001 too risky"
1. Run `cclaw orders reject --id <id> --reason "<reason>"`
2. Confirm: "Rejected [id] — reason: <reason>"

### "cancel <id>"
1. Run `node scripts/db-query.js cancel-order --id <id> --reason "<reason>" --by human` (legacy hold-back)
2. Confirm: "Cancelled [id] — reason: <reason>"

### "retry <id>"
1. Verify it's a sell order (buys cannot be retried)
2. Run `node scripts/db-query.js retry-order --id <id> --by human` (legacy hold-back)
3. Confirm: "Retried [id] — re-queued for execution."

### "order history" / "recent orders"
1. Run `node scripts/db-query.js get-order-history --limit 10` (legacy hold-back)
2. Format as a table with id, action, symbol, status, and timestamp

## Safety Rules
- NEVER auto-approve orders without explicit human instruction
- ALWAYS show order details before approving
- For "approve all", require explicit YES confirmation
- Terminal states (rejected, cancelled, executed, expired) cannot be changed
- If human tries an invalid transition, explain the correct command to use

## Error Handling
Per AGENTS.md § Error Self-Reporting: if `cclaw orders approve`, `cclaw orders reject`, or `cancel-order`/`retry-order` returns non-zero, log `node scripts/db-query.js add-research-log` with `status: "error"` and fire `node scripts/send-alert.js --type model_failure --agent research`. The human thought they approved/rejected something; a silent failure leaves the order in the wrong state and the operator misinformed.
