# ADR-0024 — BullMQ concurrency: global=1 in P1c-i, per-Safe groups in P1c-ii

**Status:** Accepted
**Date:** 2026-05-11

## Context
P1c-i adds the `execute-order` BullMQ queue and processor in `apps/worker`. Multiple orders can target the same Safe address (EVM) or Squads vault (Solana). Two concurrent executor spawns for the same Safe collide on the on-chain nonce: both fetch `nonce: N` from RPC, both build txs with that nonce, one wins, the other reverts — and subsequent rounds can cascade off-by-one. The correct policy is per-Safe-address concurrency = 1, with cross-Safe parallelism unbounded.

P1c-i, however, ships a STUB executor — no real Safe SDK calls, no real nonce. The per-Safe concurrency machinery isn't load-bearing until P1c-ii lands the real SDK. Candidates evaluated: (a) global concurrency=1 — single in-flight executor across all orders; simple, no groups, no mutex; throughput is order-of-magnitude lower than parallel execution but adequate for the order rate today (low single-digit orders/min). (b) per-Safe groups in P1c-i via BullMQ Pro or a manual OSS mutex keyed by `chain + safe_address` — implement the real policy now, no migration at P1c-ii. Building (b) against a stub buys nothing: the test proves "the mutex prevents two stubs from running concurrently," not the real nonce-collision property; the policy correctly belongs in the slice that introduces real chain config and real Safe addresses.

## Decision
**P1c-i ships `Worker({ concurrency: 1 })` globally for the `execute-order` queue. P1c-ii MUST replace this with per-Safe-address groups (group key = `order.chain + ':' + (order.safe_address ?? order.squads_vault)`, concurrency per group = 1, cross-group unbounded) in the same PR that wires the real Safe/Squads SDK, and that PR MUST reference this ADR.**

The single source of truth for the policy in P1c-i is the `@Processor` decorator and queue options in `apps/worker/src/processors/execute-order.processor.ts`. Per-Safe groups are not a SPEC §8 requirement (SPEC §8 doesn't pin a concurrency model); they are a correctness requirement that emerges from the nonce semantics of Safe / Squads transactions. This ADR captures that derivation so a future reader doesn't accept a regression to global=1 thinking it's the canonical model. The BullMQ Pro license vs OSS mutex sub-decision is deferred to P1c-ii; P1c-i makes no commitment.

## Consequences
- **+** P1c-i stays small and correct. The signer-isolation E2E test runs cleanly with no flakes from concurrent stubs racing.
- **+** The policy is documented in code (decorator) AND in this ADR; the P1c-ii diff that upgrades to per-Safe groups shows exactly what's changing and why.
- **+** No premature optimisation: the P1c-i order rate is well below the throughput that global=1 supports.
- **−** P1c-i throughput is artificially capped at one executor at a time across all chains. Acceptable today; intolerable at the order rates P2+ targets.
- **−** P1c-ii MUST close this gap. If it ships without per-Safe groups, this ADR is violated; the reviewer enforces the constraint at PR time.
- **−** The BullMQ Pro vs OSS mutex choice is parked, not solved. P1c-ii inherits that decision.
- Locked: P1c-i = global concurrency 1. P1c-ii MUST replace this with per-Safe groups AND reference this ADR. The global cap is time-bound to P1c-i; any PR landing after P1c-ii that re-introduces global=1 supersedes this ADR.

Cross-links: ADR-0004 (BullMQ + Redis — the substrate), ADR-0010 (executor isolation — the consumer of the queue), SPEC §8 (background jobs), `apps/worker/src/processors/execute-order.processor.ts` (the decorator that encodes the policy).

## Addendum (2026-05-13) — Mechanism choice locked: OSS queue-per-Safe

PR-A (P1c-ii infrastructure) is the slice that pre-installs the per-Safe topology ahead of PR-B's real Safe SDK. The mechanism sub-decision that the body of this ADR explicitly parked is now resolved.

**Choice:** one BullMQ queue per `(chain, safe_address)` pair; queue name `execute-order-<chain>-<safeAddressLowercase>`; one Worker per queue with `concurrency: 1`. Cross-queue parallelism is unbounded — distinct Safes never block each other.

**Rejected alternatives:**
- **OSS mutex on a single shared queue** (Redis `SETNX` lease keyed by `chain:safe`, taken at the top of the processor and released in a `finally`). Hand-rolled distributed locking is a known foot-gun: lease TTLs vs job duration, crash-during-release, clock skew, double-release races. The queue-per-Safe form gets the same property from BullMQ's existing per-queue concurrency invariant — no new locking primitive.
- **BullMQ Pro `group` semantics.** Solves the problem cleanly but adds a paid license. Unjustified given SPEC §17's multi-fund topology is one Safe per compose stack today; the queue count stays small and a future migration to Pro `group`s is a swap of the enumerator, not an API change.

**Implementation locus:**
- `libs/modules/orders/src/queue-names.ts` — exports `executeOrderQueueName(chain, safe)` (the single canonical source of truth for the naming convention; `apps/worker/src/queues/execute-order.queue.ts` is a re-export shim that points here).
- `apps/worker/src/app.module.ts` — enumerates queues at boot from `ACTIVE_CHAINS` config and registers a Worker per queue.
- `libs/modules/orders/src/orders.service.ts` — routes enqueues via the helper; no caller constructs queue names by hand.

**Operational consequence:** adding a new Safe to `ACTIVE_CHAINS` requires a worker restart so the new queue's Worker registers. There is no hot-reload path in P1c-ii; the `docs/runbook.md` "rotate / add a Safe" section MUST call this out in the same PR.

**Scope note:** this addendum closes the ADR-0024 mandate that the per-Safe concurrency mechanism land in the same PR as the real Safe SDK consumer. PR-A pre-installs the topology so PR-B's real Safe SDK lands into a queue layout that already enforces the nonce-collision invariant; PR-B is the first consumer. The body of this ADR (Context / Decision / Consequences) remains the canonical record of *why* per-Safe concurrency is required; this addendum records *how* it is implemented. Status remains **Accepted** — the mechanism choice is a refinement, not a supersession.

## Addendum (2026-05-14) — Scope: `execute-order` only; P3 background jobs use global singleton queues

P3g1 introduces three new BullMQ queues for the smart-money wallet pipeline: `wallet-harvest`, `wallet-scoring`, and `wallet-activity`. These jobs are explicitly **outside** the scope of this ADR's per-Safe concurrency mandate. The distinction:

- **`execute-order-*` queues** (this ADR): per-Safe topology required because two concurrent executor spawns for the same Safe collide on the on-chain nonce. One queue per `(chain, safe_address)` pair; one Worker with `concurrency: 1` per queue.
- **`wallet-harvest`, `wallet-scoring`, `wallet-activity` queues** (P3g1): global singleton topology. These jobs make read-only outbound HTTP calls (Birdeye, Zerion, Helius) and write to `tracked_wallets` / `smart_money_signals` only. No on-chain writes, no nonce semantics. Equivalent to the legacy `entrypoint.sh` loops which ran as a single process.

**Decision:** P3g1 background jobs use `concurrency: 1` on a single global-singleton queue (not per-Safe). This matches the legacy entrypoint loop model and is correct for read-only/write-to-DB-only workloads.

**Retry policy (user override 2026-05-14):** `attempts: 2` with fixed 60 s backoff. Rationale: absorbs transient Redis/network blips; second attempt leaves DB in the same state as the first (idempotency guaranteed by INSERT OR IGNORE / proposeWallet semantics).

**Implementation locus:**
- `libs/modules/wallets/src/jobs/queue-names.ts` — three constants (`WALLET_HARVEST_QUEUE`, `WALLET_SCORING_QUEUE`, `WALLET_ACTIVITY_QUEUE`); no factory function (queues are not per-Safe).
- `libs/modules/wallets/src/jobs/harvest.processor.ts` — `@Processor(WALLET_HARVEST_QUEUE, { concurrency: 1 })`.
- `apps/worker/src/app.module.ts` — registers the queue with the retry policy.
- `apps/scheduler/src/schedules/wallet-harvest.schedule.ts` — `@Cron('0 * * * *')` enqueuer.

**Supply-chain note (PR-A):** introducing `@nestjs/schedule@4.1.2` brings transitive `uuid@11.0.3` (GHSA-w5hq-g745-h8pq, moderate — buffer-bounds in v3/v5/v6 when `buf` is provided). `@nestjs/schedule` uses uuid v4 without `buf`, so there is no reachable exploit path. **Decision:** accept the transitive advisory; revisit during P3-cleanup or when `@nestjs/schedule` bumps its uuid pin to `>=11.1.1`. No `pnpm.overrides` entry added in PR-A.

Cross-links: P3g1 PR-A (`feat/p3g1-pr-a-harvest`), `libs/modules/wallets/src/jobs/harvest.processor.ts`, `docs/runbook.md §11.1`. Status remains **Accepted**.
