# ADR-0028 — Real Telegram notifications via cclaw alerts send

**Status:** Accepted
**Date:** 2026-05-17

## Context

ADR-0025 deferred real Telegram notification delivery to a later slice, using a log-only stub for the executor worker failure path. The stub was deliberately time-bound: "The PR that wires real Telegram MUST reference this ADR by number and supersede it."

P5c is that PR. By P5c, the following conditions are true:

- `libs/notifications/src/telegram.adapter.ts` and `NotificationsService` were implemented in an earlier PR (P3g3/P5) with topic routing, emoji formatting, and fire-and-forget error handling.
- The Telegram config vars (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TG_TOPIC_*`) are already validated in `libs/config/src/schema.ts`.
- `scripts/send-alert.js` was the sole Telegram notification path for the OpenClaw agent layer (shell loops + agent heartbeats). Its retention was explicitly tracked in ADR-0025 Addendum 1.
- The SPEC §17 Telegram topic contract is fully covered by the 15-literal `AlertType` union in `libs/notifications/src/telegram.adapter.ts` (single source of truth; TOPIC_MAP and EMOJI_MAP mirror `send-alert.js` bug-for-bug).

The supersession trigger was met: `NotificationsService` exists, is proven by unit tests, and an API surface is now available for agents to call.

## Decision

**Implement `POST /v1/alerts/send` in the alerts module and add `cclaw alerts send` to the CLI. Delete `scripts/send-alert.js`. Route all agent + shell-loop alert calls through the new endpoint.**

Specifics:

1. **`POST /v1/alerts/send`** — decorated `@Roles('agent')`, `@Audited()`, `@HttpCode(202)`. Body validated by `SendAlertDto` (`type: AlertType`, `agent: string`, `message: string 4000-char cap`, `data?: Record<string, unknown>`). Returns `{ accepted: true }` before Telegram delivery completes (fire-and-forget).

2. **`AlertType` single source of truth** — `SendAlertDto` uses `@IsIn(Object.keys(TOPIC_MAP))` where `TOPIC_MAP` is imported from `libs/notifications/src/telegram.adapter.ts`. No literal duplication.

3. **`AlertsService.send()`** — calls `this.notifications.sendCriticalAlert(...)` without awaiting the Telegram delivery. `NotificationsService` already swallows `TelegramBotTokenMissingError` and `TelegramApiError` internally (logs a `warn`, does not rethrow). The service therefore always resolves to `{ accepted: true }` even on TG outage.

4. **`cclaw alerts send`** — flags `--type`, `--agent`, `--message`, `--data`. Mirrors existing `cclaw alerts ack` pattern. `--data` parses as JSON (same pattern as `cclaw receipts create --json`). Exit 1 on parse failure.

5. **`entrypoint.sh` sweep** — 6 callsites in `run_executor_loop` and `run_sentinel_loop` replaced with `CCLAW_API_TOKEN="$LOOP_API_KEY" cclaw alerts send ...`. The `SAFE_ID`, `PAPER_MODE`, `DB_PATH` env-var prefixes are dropped (cclaw reads `CCLAW_API_BASE` + `CCLAW_API_TOKEN`).

6. **Agent markdown sweep** — 50+ callsites across 8+ files updated from `node scripts/send-alert.js` to `cclaw alerts send`. Observer correlation line in HEARTBEAT.md rewired from system.log grep to `cclaw system audit --path /v1/alerts/send --since 5m`.

7. **`scripts/log.js` and `scripts/redact.js` retained** — they have 4 importers in the retained set: `heartbeat-check.js`, `emergency-sentinel.js`, `emergency-executor.js`, `promote-pattern.js`. ADR-0025 Addendum 1 incorrectly attributed them to `send-alert.js` only.

8. **No rate limiting, no per-type formatters** — bug-for-bug parity with `send-alert.js`. Follow-up cosmetic per-type formatter is deferred.

## Consequences

- **+** All agent Telegram alerts now flow through the auditable NestJS API — every `cclaw alerts send` call produces an audit row, enabling the Observer's silent-crash correlation query (`cclaw system audit --path /v1/alerts/send --since 5m`).
- **+** ADR-0025's time-bound stub is closed. The log-only stub path in `apps/worker` remains correct for its specific context (executor worker failure, not agent heartbeats) and is now complemented by real Telegram delivery for the agent layer.
- **+** `scripts/send-alert.js` is gone — one fewer script to maintain; `build-templates.sh` no longer copies it to agent workspaces.
- **+** Fire-and-forget semantics are preserved — `cclaw alerts send` exits immediately with `{ accepted: true }`, so agent heartbeats are not blocked by Telegram outages.
- **−** `entrypoint.sh` shell-loop alerts now require the NestJS API to be running. If the API is down during a model failure event, the `cclaw alerts send` call will fail silently (same as the legacy `node scripts/send-alert.js` call — both exited 0 on failure). The API-down scenario is itself an operator issue that the Observer would surface separately.
- **−** `LOOP_API_KEY` is now used by `entrypoint.sh` for the `cclaw alerts send` calls. This key was already exported by the entrypoint; no new secret required.

## Cross-links

- ADR-0025 (superseded) — original deferral and stub form
- ADR-0026 — per-field config injection (governs `AlertsService` + `NotificationsService` config access)
- SPEC §17 — Telegram alert topics (the contract implemented here)
- `libs/notifications/src/telegram.adapter.ts` — `AlertType` union + `TOPIC_MAP` + `EMOJI_MAP` (single source of truth for type routing)
