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
