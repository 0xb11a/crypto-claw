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

Process all approved orders by calling `node scripts/process-order.js --order-id <ID>` for each — sells before buys. The script owns the entire lifecycle (validation, execution, receipt, position write, cash update, mark executed/failed, alert).

**Always start by reading `HEARTBEAT.md` and `AGENTS.md` in this agent's workspace** — they hold the full step-by-step procedure (load orders, process each, log + heartbeat, error self-reporting). This skill is loaded lazily; do not assume those files are already resident in context.

Every failure path must produce both a `status: "error"` executor_log row AND a Telegram alert via `send-alert.js` before the agent returns. Silent DB failure is the single worst Executor path — a quiet cycle is only quiet if `get-orders` actually succeeded.
