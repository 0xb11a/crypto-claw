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

Follow the procedure in HEARTBEAT.md. That is the single source of truth for order processing.

Error handling lives in AGENTS.md § Error Self-Reporting and the matching sections of HEARTBEAT.md: every failure path must produce both a `status: "error"` executor_log row AND a Telegram alert before the agent returns. Silent DB failure is the single worst Executor path — a quiet cycle is only quiet if `get-orders` actually succeeded.
