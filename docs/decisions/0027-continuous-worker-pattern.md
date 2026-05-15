# ADR-0027 — Continuous-Worker pattern for callback-driven jobs (approval-bot)

**Status:** Accepted
**Date:** 2026-05-15

## Context

P3g3 introduces the approval-bot, the only SPEC §8 deterministic loop that does not fit the `@Cron` + BullMQ `@Processor`/`Queue` shape used by all other P3 background jobs (wallet-harvest, wallet-scoring, wallet-activity, governance-drift, multisig-tracking, position-reconcile, portfolio-report).

Telegram delivers approval/reject button events via the `getUpdates` long-polling API. The event stream is continuous and arrival-time is unpredictable — there is no fixed cadence, no external queue to drain. The correct model is: keep a persistent HTTP long-poll connection open with a `timeout=30` window so Telegram holds it open until an event arrives or the timeout elapses, then immediately re-issue another poll.

Candidates evaluated:

**(a) `@Injectable` service with `OnApplicationBootstrap` / `OnApplicationShutdown` lifecycle hooks (chosen)**
An `AbortController`-cancellable `while (!signal.aborted)` loop starts in `onApplicationBootstrap` and is cancelled cleanly on `onApplicationShutdown`. No BullMQ queue, no scheduler. The loop owns its own exponential-backoff retry on errors and persists the Telegram `update_id` offset in `portfolio_meta` via `SystemService.setMeta` so restarts never reprocess the same callback.

**(b) BullMQ `Worker` with a single "tick" job that re-enqueues itself (rejected)**
Mapping a continuous poll to a job-queue model is impedance mismatch: the re-enqueue delay (configurable) either creates latency (operator waits >1s for their approve/reject to register) or hammers Redis with empty ticks. It also adds Redis as a synchronisation point for what is fundamentally an in-process async loop. Gains nothing over option (a); adds complexity.

**(c) Webhook endpoint → enqueue → process (rejected)**
Requires a publicly routable HTTPS endpoint. CryptoClaw does not expose the worker to the internet (SPEC §4, ADR-0006); adding a webhook surface would require a reverse proxy and TLS setup that is out of scope for P3. The long-poll model is expressly designed for environments that cannot accept inbound connections.

## Decision

The approval-bot is implemented as a NestJS `@Injectable` service (`ApprovalBotService`) placed in `libs/modules/orders/` (the entity that owns order state transitions). The service:

1. Implements `OnApplicationBootstrap` and `OnApplicationShutdown`.
2. Owns a private `AbortController`; the `signal` is passed to every `fetch` call (`TelegramAdapter.getUpdates`) so SIGTERM cancels the in-flight long-poll within 1 s.
3. Persists the Telegram `update_id` offset in `portfolio_meta.approval_bot_offset` via `SystemService.setMeta` on every successful poll that returned at least one update — never reprocesses the same event across restarts.
4. Implements exponential backoff starting at 1 s, capping at 60 s, on any poll error; resets to 1 s on success.
5. Skips startup gracefully when `TELEGRAM_BOT_TOKEN` is absent or `PAPER_MODE=true`.
6. Authorization: only processes callbacks from `TELEGRAM_OWNER_ID` (numeric user ID); all other senders receive `answerCallbackQuery` "Unauthorized" and the event is skipped.
7. Order-state transitions use `OrdersRepository.transitionApproval(id, fromStatus, toStatus, approvedBy)`, which performs an atomic `prisma.order.update({ where: { id, status: fromStatus } })` and returns `{ updated: boolean; order?: OrderResponseDto }` — catching Prisma P2025 (record-not-found / status mismatch) so concurrent clicks or stale buttons are handled gracefully.
8. After a successful transition, edits the original Telegram message via `TelegramAdapter.editMessageText` to remove the inline keyboard and marks the decision in the message text.
9. Always calls `systemService.setMeta('last_approval_bot_at', now)` each iteration so health monitoring can detect a stalled loop.

No new BullMQ queue. No scheduler entry. The service is registered in `apps/worker` via `OrdersModule.forWorker()` (additive to the existing multisig-tracker registration in that method).

## Consequences

**Positive:**
- Simpler than any queue-wrapping approach — one `while` loop, no Redis coordination.
- SIGTERM responsiveness is guaranteed by the `AbortController` pattern: the in-flight 30 s long-poll is cancelled immediately; `onApplicationShutdown` waits up to 5 s for the loop to exit.
- Offset persistence means a worker restart never re-applies an approval/rejection.
- No new infrastructure dependency (no public endpoint, no reverse proxy).
- Fits cleanly inside the existing `apps/worker` lifecycle — tested by the existing DI smoke in `apps/worker/src/app.module.spec.ts`.

**Negative / trade-offs:**
- Loses BullMQ's built-in retry/backoff semantics for the poll itself — inline backoff replaces them.
- Crash-resilience: a worker crash mid-handler must not silently lose the update. Mitigation: the `update_id` offset is persisted in `portfolio_meta.approval_bot_offset` only AFTER the batch's order transitions complete and the offset write happens inside the same `setMeta` call. A crash before that write means the next restart re-fetches the same batch and re-processes it; this is safe because `OrdersRepository.transitionApproval` is atomic and idempotent — the second attempt either sees the row already in the target state and returns `{ updated: false }` (mapped to "already processed") via Prisma's P2025 path, or completes the originally-interrupted transition.
- The loop runs in the worker process's main thread; a hung handler (e.g., a very slow Prisma write) blocks the poll. Mitigation: Prisma operations are bounded by the database connection timeout; `answerCallbackQuery` is always called in a `finally`-adjacent block so Telegram does not time out the callback query.
- The legacy `scripts/approval-bot.js` continues to run in parallel via `entrypoint.sh:run_approval_bot` until P5 cutover (DoD §I). Both instances poll the same Telegram update stream; Telegram guarantees only one `getUpdates` client with a given token is served at a time (subsequent calls with `timeout>0` displace the previous long-poll). In practice this means whichever service wins the poll slot processes that batch; the other re-polls immediately. Both write to the same `orders` table, both check `status = 'pending'` atomically — no double-processing is possible because the Prisma `where: { id, status }` guard means only the first writer succeeds. The second call sees P2025 and reports "already processed".

**Cross-links:**
- SPEC §8 (background jobs table — approval-bot row).
- ADR-0024 (per-Safe scope explicitly excludes this job: no signer key, no nonce semantics).
- ADR-0024 addendum 2026-05-14 (global-singleton shape confirmed for P3 non-execute-order jobs).
- ADR-0026 (typed-config injection — all `configService.get<T>('FIELD')` reads in `ApprovalBotService`).
- `libs/modules/orders/src/jobs/approval-bot.service.ts` — the implementation.
- `libs/modules/orders/src/orders.repository.ts` — `transitionApproval` method.
