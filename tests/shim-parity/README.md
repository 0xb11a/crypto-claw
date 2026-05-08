# Shim parity baseline — regression oracle for P1–P4

This directory holds the byte-for-byte JSON snapshots of every read-only CLI command run against a populated dev DB **before** the rewrite begins. During phases P1–P3, the new `cclaw` CLI is asserted against these snapshots; any drift is a regression. At P4 cutover, baselines are re-captured from `cclaw` itself; at P5, this directory is deleted.

## Files

```
tests/shim-parity/
├── README.md                 # This file
├── capture-baseline.js       # Runner that emits the snapshots
├── compare-baseline.js       # Diff runner used in tests
└── baseline/
    ├── manifest.json         # The set of (command, args) pairs captured, with sampled IDs
    └── <command>/<argHash>.json   # One file per (command, args) snapshot
```

## How to capture (operator action — run before P1 begins)

```
# 1. Pick a populated dev DB. The most recent rolling dev DB is recommended.
SAFE_ID=dev-live-fund0

# 2. Run the capture
node tests/shim-parity/capture-baseline.js --safe-id "$SAFE_ID" --commit-baseline
```

The script:
1. Loads the database read-only.
2. Samples real IDs / addresses / chain values from the populated tables (e.g., the first open position's ID, the most recent order ID, a tracked wallet on each active chain).
3. For every read-only `db-query.js` subcommand, runs it with the sampled args and writes stdout to `baseline/<command>/<argHash>.json`. The `argHash` keeps invocations with different args separate.
4. Writes `baseline/manifest.json` listing every (command, args) pair captured plus a content hash of the populated DB. The content hash lets re-captures detect when the source DB has shifted.
5. Exits non-zero if any command exits non-zero or produces non-JSON stdout.

Commit the resulting `baseline/` tree to the `v2` branch.

## How to compare (CI gate — runs in P1–P3)

`tests/shim-parity/compare-baseline.js` re-runs each captured (command, args) pair against the same `SAFE_ID` and diffs the new stdout against the committed snapshot. Any byte-level difference fails CI. The intent is unforgiving: identical output is the only acceptance criterion until P4 cutover.

## What's NOT captured

- **Write commands.** They mutate state, so a "baseline" doesn't make sense. Their semantics are tested in `tests/integration/` per module.
- **External-API-dependent commands** (`scan-tokens.js`, `token-metrics.js`, `check-contract.js`, `check-positions.js`, etc.). These are network-dependent and non-deterministic; their parity is asserted by integration tests against recorded fixtures, not by byte diffs.
- **Background loops.** `score-wallets-bg.js`, `activity-wallets-bg.js`, `track-multisig.js`, `reconcile-positions.js` — covered by `tests/e2e/` against testcontainers.

## Lifecycle

| Phase | Action |
|---|---|
| P-prep | Capture baseline; commit `baseline/` and `manifest.json` |
| P1–P3 | CI runs `compare-baseline.js` on every PR touching migrated modules |
| P4 | Re-capture baseline from `cclaw` after agent markdown sweep; new baseline becomes the rolling regression oracle for any future change to `cclaw` |
| P5 | Delete `tests/shim-parity/` entirely; legacy `db-query.js` is gone, `cclaw` is the only surface |
