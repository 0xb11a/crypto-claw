# ADR-0020 — Shim-parity baseline: capture-once, compare-every-PR until P5

**Status:** Accepted
**Date:** 2026-05-10

## Context
SPEC §19 verification #2 requires `cclaw <…>` JSON byte-identical to `node scripts/db-query.js <…>` against the same DB during the rewrite (P1–P5). The legacy `scripts/db.js` schema and `scripts/db-query.js` output format are the de-facto contract — operator-facing tools, agent skill markdown, and emergency runbook commands all assume that exact JSON shape. Any drift in the rewrite that the unit/integration tests don't catch (column ordering, JSON-string field encoding, NULL vs missing-key, datetime format) will silently break consumers.

The harness for this lives in `tests/shim-parity/`: `capture-baseline.js` (operator-run, snapshots stdout for every read-only `db-query` subcommand against a populated dev DB) and `compare-baseline.js` (CI-run, re-executes via the new `cclaw` and asserts byte-identical JSON). The baseline files are checked into the repo under `tests/shim-parity/baseline/<command>/<argHash>.json` plus a `manifest.json`.

P1a's baseline was captured against an **empty dev DB** (the operator does not run a fund locally; the SAFE_ID was new and `db.js`'s auto-migration created the schema with no rows). This means the baseline catches **structural** drift (wrapper shape, key names, NULL vs missing-key, datetime format, empty-state response shape) but **not data-shape** drift (column ordering inside rows, JSON-string field encoding inside row data, edge cases that only manifest with real data). For the duration of P1a–P1b, the harness is necessarily limited to structural parity. The data-shape gap is closed by **synthetic-data unit tests** inside each module (e.g., `libs/modules/positions/spec/parity.spec.ts`) that synthesize representative rows, route them through both `db-query.js` and the new Prisma repository, and assert byte-identical JSON. Those tests live with the modules they cover.

The risk if the workflow is left informal: the operator captures a baseline once, the modules-shipping PR runs `compare-baseline.js`, the gate passes, the operator forgets to re-capture when legacy `db.js` ships a fix or a new column. The next PR's baseline-vs-current diff is now 50% legitimate (rewrite) and 50% legacy-fix-not-mirrored. By P3 the baseline is meaningless.

## Decision
**Capture the shim-parity baseline exactly once at the start of P1a; re-capture only in PRs that modify the legacy scripts; run `compare-baseline.js` as a hard CI gate on every PR from P1a through P5; delete the harness at P5 cutover.**

1. **Capture happens exactly once at the start of P1a.** The operator runs `node tests/shim-parity/capture-baseline.js --safe-id <dev-fund-id>` against a populated dev DB and commits the result. This snapshot is the immutable reference for the duration of the rewrite — *the legacy is frozen for parity purposes*.

2. **Every subsequent legacy modification to `scripts/db.js` or `scripts/db-query.js` requires a fresh baseline capture in the same PR.** DoD §I says legacy is untouched while in service, so this is rare; if it happens, the PR description explicitly notes "baseline re-capture required" and the operator runs the capture as a step. CI does NOT auto-recapture.

3. **`compare-baseline.js` runs in `pr.yml` as an ADVISORY gate during P1a–P1b** (`continue-on-error: true`) because the empty-DB baseline is structurally weaker than originally planned. Per-module synthetic-data parity tests are the load-bearing assertion for byte-identical JSON during this window; the harness is the long-running structural floor. The gate filters by `--only` flag to scope to commands whose modules are actually implemented in the new system at the time of the PR (P1a: positions, orders; P1b: receipts, alerts, heartbeat; P2: rest). Commands not yet implemented are skipped with a clear "not yet implemented" message; they're not failures.

4. **The gate hardens to a blocking gate** when EITHER (a) the operator captures a fresh baseline against a populated dev DB (synthesized via P1c/P2's seed-test-data tooling, or against a real fund), OR (b) the synthetic-data unit tests achieve full coverage of every read path that real data would exercise. Whichever happens first triggers the flip. The PR that flips removes `continue-on-error: true` from `pr.yml` and notes in its description that the empty-baseline window is closed.

5. **The `--only` flag's allowlist lives in `tests/shim-parity/compare-baseline.js`** as a small `IMPLEMENTED_COMMANDS` array. Updating it is part of every module-shipping PR. Forgetting to add a command means the gate doesn't catch its drift — caught by review.

6. **At P5 cutover, the harness is deleted.** Once legacy `scripts/db-query.js` is removed, parity has nothing to compare against and the gate has served its purpose. The deletion PR removes `tests/shim-parity/` entirely.

This ADR does NOT change the SPEC, the harness, or the migration strategy. It makes explicit the lifecycle the harness is designed for.

## Consequences
- **+** A drift between `cclaw` output and `db-query.js` output cannot land in `v2` once a command is in `IMPLEMENTED_COMMANDS` — once the gate flips from advisory to blocking (per Decision #4), it's a hard CI gate.
- **+** The single-capture rule prevents the silent-staleness failure mode where the baseline rots into a 50/50 mix of legitimate rewrite changes and unmirrored legacy fixes.
- **+** Deletion at P5 means no perma-overhead — the gate exists exactly as long as it has something to compare against.
- **+** Per-module synthetic-data parity tests are co-located with the module they verify; a regression touches the same test file the developer is editing.
- **−** During P1a–P1b the empty-DB baseline only catches structural drift; real data-shape drift can land if the synthetic-data tests are incomplete. Reviewer must verify each module's parity tests cover the realistic shapes (positions in open / closed / paper states, orders across the lifecycle, etc.) before approving.
- **−** The baseline files take real disk and PR-diff churn — an early-P1 capture against a dev DB with thousands of trades produces megabytes of JSON. Mitigated by capturing against a small or empty dev DB; current capture is empty so churn is minimal.
- **−** The `IMPLEMENTED_COMMANDS` allowlist is a maintenance burden; mitigated by its small size and by being part of the same PR that ships each module — never updated in isolation.
- Locked: capture-once, compare-every-PR for P1–P5; the harness is deleted at P5; the gate is advisory in P1a–P1b and blocking thereafter (or when the empty-baseline window closes, whichever comes first).

Cross-links: SPEC §19 verification #2 (the requirement this implements), SPEC §18 (P5 deletion phase), DoD §I (legacy untouched while in service), `tests/shim-parity/README.md` (the harness operator-facing docs), `tests/shim-parity/capture-baseline.js`, `tests/shim-parity/compare-baseline.js`.

## Addendum 1 (2026-05-14) — Byte-identical parity contract upgrade (partial)

The original P1 parity specs used shape-only assertions (e.g., `expect(typeof row['x']).toBe('string')`). P2 introduced byte-identical parity via `research-log-parity.spec.ts` (`expect(apiOutput).toEqual(legacyOutput)` against the same DB file).

**Byte-identical (deepEqual) specs — 8 total:**
- 4 P2 specs: `wallets-parity.spec.ts` (port 7891), `signals-parity.spec.ts` (port 7892), `liquidity-parity.spec.ts` (port 7893), `watchlist-parity.spec.ts` (port 7894)
- 4 agent-log specs: `research-log-parity.spec.ts`, `sentinel-log-parity.spec.ts`, `executor-log-parity.spec.ts`, `observer-log-parity.spec.ts`

**Shape-only specs — 5 P1 specs (remain non-byte-identical):**
- `heartbeat-parity.spec.ts` (port 7886)
- `positions-parity.spec.ts` (port 7887)
- `orders-parity.spec.ts` (port 7888)
- `receipts-parity.spec.ts` (port 7889)
- `alerts-parity.spec.ts` (port 7890)

These 5 P1 specs remain shape-only because their DTOs intentionally diverge from legacy CLI output via:
1. `mode: 'real' | 'paper'` discriminator (positions, receipts) — the API UNION response adds this field; legacy CLI has no equivalent.
2. JSON-string columns parsed into typed arrays (positions, orders, alerts — `take_profit_levels`, `tp_levels_hit`) — the API parses additional JSON columns that the legacy CLI leaves as raw strings, making field-level parity fragile across future schema changes.
3. Timing-derived fields recomputed independently per request (heartbeat `seconds_since`) — both sides compute this from `NOW()` at different instants, causing a 1-second timing race that makes deepEqual non-deterministic.

Full retrofit of these 5 P1 specs would require either reverting these API design wins or building a `normalizeForParity()` translation layer — deferred indefinitely.

`IMPLEMENTED_COMMANDS` in `tests/shim-parity/compare-baseline.js` now includes wallets/liquidity/watchlist entries that were missing in P2 group 1.

The legacy SQLite schema was untouched (DoD §I). Synthetic-data unit tests inside each module remain the secondary safety net.

Status: Accepted (unchanged).
