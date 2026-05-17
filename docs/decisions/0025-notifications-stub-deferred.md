# ADR-0025 — Notifications deferred: log-only stub in P1c-i, real Telegram in a later slice

**Status:** Superseded by ADR-0028
**Date:** 2026-05-11

## Context
SPEC §11 makes structured logs the primary observability surface; SPEC §17 references Telegram alert topics (`TG_TOPIC_EXECUTOR`, `TG_TOPIC_ALERTS`, etc.) for operator-facing failures. Legacy `scripts/send-alert.js` sends Telegram messages to those topics on execution failure. P1c-i adds the worker's `execute-order` processor — when an executor child exits non-zero, the question is who tells the operator.

Candidates evaluated: (a) wire real Telegram in P1c-i — implement `libs/notifications/src/telegram.client.ts` and topic routing against the Telegram Bot API; adds ~200 LOC, new env vars (`TELEGRAM_BOT_TOKEN`, `TG_TOPIC_*`), new gated integration tests, and gives operators DUPLICATE alerts (new + legacy) until the P4 cutover retires the legacy path. (b) log-only stub — emit one structured `executor_failed_alert` line via `libs/logger` on every executor failure with the fields a human responder needs; the legacy stack continues to send the real Telegram message, so operators see exactly one alert per failure. (c) skip alerting entirely — unacceptable; production incidents need active alerts. Choice (b) is the right size for P1c-i: the legacy path is still authoritative until P4 cutover, real Telegram has its own surface area (token rotation, rate limits, topic edge cases, mock-vs-live test strategy, bot-token secret management), and cramming it into P1c-i dilutes the load-bearing signer-isolation focus. The deferral is time-bound and self-announcing: this ADR records that a later slice MUST supersede it when real Telegram lands.

## Decision
**P1c-i emits a single structured `executor_failed_alert` log line via `libs/logger` on every executor non-zero exit; no Telegram client, no new env vars, no changes to `libs/notifications/` (which stays the P0a placeholder). The legacy `scripts/process-order.js` continues to send Telegram alerts via `scripts/send-alert.js` during the rewrite window. The PR that wires real Telegram (P1d or a folded slice) MUST reference this ADR by number and supersede it.**

The log shape in `apps/worker/src/processors/execute-order.processor.ts`:

```typescript
this.logger.error('executor_failed_alert', {
  orderId: order.id,
  chain: order.chain,
  symbol: order.symbol,
  action: order.action,
  errorKind: receipt.error_kind ?? 'unknown',
  errorMessage: receipt.error ?? 'unknown',
  spawnLatencyMs: result.latencyMs,
  suggestedAction: 'check_executor_logs_and_retry',
});
```

The superseding PR MUST: (1) set this ADR's `Status:` to `Superseded` and add a `**Superseded by ADR-NNNN**` line, (2) implement `libs/notifications/src/telegram.client.ts` with topic routing matching `scripts/send-alert.js`, (3) add `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_ID`, and the `TG_TOPIC_*` vars to `libs/config/src/schema.ts`, (4) gate integration tests behind `CCLAW_TELEGRAM_TESTS_ENABLED=1` following the `CCLAW_LIVE_API_AT_7878=1` pattern from P1b.

## Consequences
- **+** P1c-i scope stays focused on signer isolation; no Telegram-SDK bikeshedding inside the slice that has to get key handling right.
- **+** Operators get exactly one alert per failure (from the legacy path) during the rewrite window — no duplicate-alert noise.
- **+** The structured log entry is a forensic record: searchable, exportable to SIEM, useful for postmortems even after real Telegram lands.
- **+** The supersession path is explicit; a future reader sees in this file what the next slice has to do.
- **−** New-stack consumers (dashboards, future SDKs) cannot subscribe to alerts via the canonical channel until real Telegram lands. Acceptable: there are no such consumers in P1c-i.
- **−** The log-only stub could be missed if log shipping is misconfigured. Mitigated: the `executor_failed_alert` sentinel is trivial to grep; the runbook documents the command.
- **−** This ADR is deliberately temporary. A future reader must check `Status:` before assuming the stub form is canonical. The supersession PR closes the deferral.
- Locked time-bound: stub form valid for P1c-i and the rewrite window only. The PR that wires real Telegram MUST supersede this ADR; no third notifications path is admissible.

Cross-links: SPEC §11 (logging — the canonical surface for the stub), SPEC §17 (Telegram topics — the contract the real slice must satisfy), ADR-0010 (executor isolation — the source of failure events), `libs/logger/src/redactor.ts` (the redaction patterns the alert log line uses), legacy `scripts/send-alert.js` (the contract the real slice must port).

## Addendum 1 (2026-05-17) — P5 retention reaffirmed

`scripts/send-alert.js`, `scripts/log.js`, and `scripts/redact.js` were explicitly retained in the P5 legacy-deletion PR (the "big deletion" commit). These three scripts remain as the sole Telegram notification path for the legacy OpenClaw agent layer. Their retention was reviewed against ADR-0025 and confirmed appropriate:

- `entrypoint.sh` invokes `send-alert.js` in `run_executor_loop` and `run_sentinel_loop` for model failure, emergency mode, and recovered events — no NestJS-side replacement for these shell-to-Telegram paths yet.
- All four agents reference `send-alert.js` in their agent markdown for the retained hold-back alert paths. Removing them before the supersession PR would leave agents with no Telegram alerting path.

The supersession PR (P5c) was expected to: implement `libs/notifications/src/telegram.client.ts`, add the env vars to `libs/config/src/schema.ts`, gate tests behind `CCLAW_TELEGRAM_TESTS_ENABLED=1`, delete `scripts/send-alert.js` + `scripts/log.js` + `scripts/redact.js`, and set this ADR's `Status:` to `Superseded`.

**Status now: Superseded by ADR-0028.** See Addendum 2 below.

## Addendum 2 (2026-05-17) — Superseded by ADR-0028

P5c landed. `scripts/send-alert.js` was deleted; `scripts/log.js` and `scripts/redact.js` were retained (Addendum 1 incorrectly said they would be deleted — they have four other importers: `heartbeat-check.js`, `emergency-sentinel.js`, `emergency-executor.js`, and `promote-pattern.js`).

The plan-stated supersession path was implemented via `POST /v1/alerts/send` + `cclaw alerts send` wired to `NotificationsService.sendCriticalAlert` (ADR-0028). The Telegram env vars (`TELEGRAM_BOT_TOKEN`, `TG_TOPIC_*`) were already present in `libs/config/src/schema.ts` from an earlier PR; no new schema changes were required in P5c.

See ADR-0028 for the full decision record.
