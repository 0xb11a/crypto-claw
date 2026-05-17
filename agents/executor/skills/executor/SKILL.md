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

Process all approved orders by calling `cclaw orders execute --id <ID>` for each — sells before buys. A 202 response means the order is enqueued for the `ExecuteOrderProcessor` (NestJS worker), which owns the entire lifecycle (validation, execution, receipt, position write, cash update, mark executed/failed, alert). Confirm results on subsequent heartbeats via `cclaw orders get --id <ID>` — status will progress to `executed` / `failed` / `rejected`.

To fetch approved orders, use:
- Sells: `cclaw orders list --status approved --action sell`
- Buys: `cclaw orders list --status approved --action buy`

**Always start by reading `HEARTBEAT.md` and `AGENTS.md` in this agent's workspace** — they hold the full step-by-step procedure (load orders, execute each, log + heartbeat, error self-reporting). This skill is loaded lazily; do not assume those files are already resident in context.

Every failure path must produce both a `status: "error"` executor_log row (via `node scripts/db-query.js add-executor-log`, legacy hold-back) AND a Telegram alert via `cclaw alerts send` before the agent returns. Silent failure is the single worst Executor path — a quiet cycle is only quiet if the order fetch actually succeeded and `cclaw orders execute` returned 202 for each order.
