# MEMORY.md — CryptoClaw Long-Term Memory

> This file is curated **agent-level** memory. Shared across all deployments.
> Update when a pattern is observed 3+ times. Remove patterns that stop working.
> Wallet-specific data (positions, trades, watchlist) lives in the database.

## Market Patterns (Learned)

*No patterns yet. This file will grow as CryptoClaw trades and learns.*

### Template for new patterns:
```
### [Pattern Name]
- **Observed:** X times
- **Confidence:** X%
- **Description:** What happens
- **Signal:** What to look for
- **Action:** What to do when seen
- **Last seen:** YYYY-MM-DD
- **Outcome history:** Win/loss record
```

## Lessons Learned

*No lessons yet. After each trade closes, a lesson will be added here.*

### Template for lessons:
```
### [YYYY-MM-DD] [Token Symbol] — [Win/Loss]
- **Entry:** $X at score XX
- **Exit:** $X (reason)
- **P&L:** +/-XX%
- **What went right:**
- **What went wrong:**
- **Rule to remember:**
```

## Known Scam Patterns

### Deployer Reuse
- Scam deployers often create multiple tokens from the same address
- Always check deployer's history before entering

### Fake Liquidity Lock
- Some tokens show "locked" LP but use custom lockers with backdoors
- Verify lock contract is a known locker (Unicrypt, Team Finance, PinkSale)

### Honeypot Variants
- Max wallet limits that prevent selling above small amounts
- Tax that increases over time (low at launch, high later)
- Blacklist function that blocks sellers

## Scoring Calibration

*Track how well the scoring model predicts outcomes:*

| Score Range | Trades | Wins | Win Rate | Notes |
|-------------|--------|------|----------|-------|
| 80-100 | 0 | 0 | — | |
| 60-79 | 0 | 0 | — | |
| 50-59 | 0 | 0 | — | |

## Narrative Performance

*Track which narratives produce the best results:*

| Narrative | Trades | Avg P&L | Best | Worst | Notes |
|-----------|--------|---------|------|-------|-------|
| AI | 0 | — | — | — | |
| RWA | 0 | — | — | — | |
| DePIN | 0 | — | — | — | |
| Memecoin | 0 | — | — | — | |

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T13:48:30.226Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T13:48:30.919Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:08:55.087Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:08:55.780Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:10:18.962Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:10:19.346Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:11:17.193Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:11:17.612Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:11:52.861Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:11:53.253Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:12:32.875Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:12:33.288Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:15:43.307Z -->
### Unit Test Pattern Sentinel Liquidity (seen: 3 times, attestation: risk)
- **Description:** A test pattern description for unit testing
- **Signal:** When price drops 10% in 1 hour
- **Action:** Add risk weight 2x
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18

<!-- via promote-pattern.js attestation=risk derived_from=receipt:rcpt-abc-123 seen=3 ts=2026-05-18T14:15:43.987Z -->
### Valid Pattern (seen: 3 times, attestation: risk)
- **Description:** Should succeed since cclaw exits 0
- **Signal:** Some signal
- **Action:** Some action
- **Derived from:** 1 ground-truth row(s)
- **Last updated:** 2026-05-18
