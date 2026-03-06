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
