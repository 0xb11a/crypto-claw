---
description: Run the test suite with coverage; check per-module results against SPEC §14 thresholds.
---

Run the coverage report:

```bash
pnpm coverage
```

After it finishes, parse the per-module line and branch coverage and check it against SPEC §14 thresholds:

| Module | Line | Branch |
|---|---|---|
| `libs/modules/*` (positions, orders, receipts, alerts, watchlist, wallets, liquidity, contracts, heartbeat, agent-logs, trades, analysis-cache, paper, system) | ≥95% | ≥85% |
| `libs/{auth,audit,logger,config,health,notifications,market,chain,portfolio,execution}` | ≥85% | — |
| Aggregate (excl. bootstrap files in `apps/*/main.ts`) | ≥80% | — |

Print a table: `module | line% | branch% | status`. Use ✓ for pass and ✗ for fail (with the specific threshold the module missed).

For any module below threshold, list the uncovered lines from the report (`file:line`). Don't auto-write tests in this turn — that's the `tester` agent's job.

If a module exists under `libs/` or `apps/` but has zero test coverage, treat that as a failure too — flag it explicitly.

Stop after the report. Suggest follow-up but don't take action.
