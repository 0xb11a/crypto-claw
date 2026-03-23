---
name: portfolio
description: Position sizing, trade proposals, exit strategy, and portfolio rebalancing
triggers:
  - buy token
  - sell token
  - trade proposal
  - position size
  - rebalance
  - portfolio review
  - take profit
  - stop loss
  - exit strategy
---

# Portfolio Skill

## Purpose
Convert risk-assessed opportunities into concrete trade proposals. Manage sizing, entries, exits, and rebalancing.

### Step 0: Load Configuration (MANDATORY — run before any portfolio action)
```bash
echo "=== PORTFOLIO CONFIG ==="
echo "PAPER_MODE=${PAPER_MODE:-false}"
echo "ACTIVE_CHAINS=${ACTIVE_CHAINS:-base}"
echo "======================"
```
Read the output. This determines your entire cycle:
- `PAPER_MODE=true` → use paper commands (`get-paper-portfolio`, `get-paper-cash`, `get-paper-positions`, `get-paper-stats`), auto-approve trades
- `PAPER_MODE=false` → use real commands, require human approval
Always include `--chain <chain>` on portfolio and cash commands. Reference this output throughout.

## When to Use
- After risk skill approves a token
- When take-profit or stop-loss levels are hit
- When user requests portfolio review
- During scheduled rebalance checks

## Allocation Targets

| Tier | Target | Range | Examples |
|------|--------|-------|---------|
| Base | 50% | 40-60% | BTC, ETH, SOL |
| Conviction | 25% | 20-30% | Established alts with fundamentals |
| Moonshot | 15% | 10-20% | New high-risk plays |
| Cash | 10% | 10-20% | USDC, USDT |

All allocation percentages are per-chain. Read chain rules with `getPortfolioRules(chain)` before sizing. If `tiersEnabled` for the chain doesn't include the proposed tier, reject the trade.

## Entry Strategy — Scale In, Never Ape

| Tranche | % of Planned Position | Trigger |
|---------|----------------------|---------|
| Initial | 30-50% | Analysis + risk approval |
| Confirmation | 30-40% | Rising holders, volume, thesis confirmed |
| Final | 20-30% | Dip/consolidation (better entry) |

## Exit Strategy

### Take-Profit Levels
| Level | Multiplier | Sell % | Purpose |
|-------|-----------|--------|---------|
| TP1 | 2-3x | 40-50% | Recover initial capital |
| TP2 | 5x | 30% | Lock in profit |
| TP3 | 10x+ | 10-15% | Capture outsized gains |
| Moonbag | — | Keep 5-10% | Free ride, no stop-loss |

### Stop-Loss
| Tier | Stop-Loss | Time Stop |
|------|----------|-----------|
| Moonshot | -40% to -50% | 7 days no catalyst |
| Conviction | -25% to -30% | 14 days no catalyst |

### Immediate Exit Triggers
- Sentinel alerts: rug warning, liquidity drain
- Dev wallet starts selling
- Contract upgraded without announcement
- Honeypot activation (sells failing)

## Trade Proposal Format

When proposing a trade to the human, use this format:

```
📊 TRADE PROPOSAL

Action: BUY / SELL
Token: $SYMBOL (chain)
Address: 0x...

Amount: $X,XXX (X.X% of portfolio)
Tier: Moonshot / Conviction
Entry Price: $X.XXXX

Stop-Loss: $X.XXXX (-XX%)
TP1: $X.XXXX (Xx, sell XX%)
TP2: $X.XXXX (Xx, sell XX%)
TP3: $X.XXXX (Xx, sell XX%)

Analysis Score: XX/100
Risk Score: XX/100
Risk Verdict: approve / approve_with_caution

Reasoning:
[2-3 sentences on why this trade, why now, why this size]

⚠️ Risks:
[Top 2-3 risk flags]

Reply APPROVE or REJECT
```

## Rebalancing Process

### When to Rebalance
- After a moonshot hits TP1 or TP2 → rotate profits to base/cash
- Any tier exceeds its range by >5%
- Weekly review (scheduled via heartbeat)
- After portfolio drawdown >15%

### How to Rebalance
1. Check `PAPER_MODE` env var
2. If paper mode: run `node scripts/db-query.js get-paper-portfolio --chain <chain>` and `node scripts/db-query.js get-paper-cash --chain <chain>`
3. If real mode: run `node scripts/portfolio-summary.js --chain <chain>`
4. Calculate current vs target allocation
5. Identify overweight/underweight tiers
6. Propose specific sells (weakest positions in overweight tier)
7. Propose specific buys or cash retention for underweight tier:
   - **If base tier is underweight:** Propose buying the most underweight base asset. Prefer spreading across multiple base assets when available on the same chain (e.g., both WETH and cbBTC on Base) to improve diversification. Use `node scripts/token-metrics.js --address <BASE_TOKEN_ADDRESS> --chain <CHAIN>` to get current price. Base tokens per chain:

     **Base chain (EVM):**
     - WETH: `0x4200000000000000000000000000000000000006`
     - cbBTC: `0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf`

     **Solana:**
     - wSOL: `So11111111111111111111111111111111111111112`

   - **If conviction tier is underweight:** Check watchlist and recent analyses for conviction-rated tokens, or trigger a conviction scan via `node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30`
   - **If moonshot tier is underweight:** Normal discovery pipeline handles this
8. If paper mode: auto-approve. If real mode: send rebalance proposal to human

## Writing Orders to Database

After formatting the trade proposal, write the order to the database. The `add-order` command automatically sets the correct status:
- **Paper mode** (`PAPER_MODE=true`): auto-approved (`status: 'approved'`, `approved_by: 'paper_mode'`)
- **Real mode**: pending human approval (`status: 'pending'`)

```bash
node scripts/db-query.js add-order --json '{
  "id": "trade-<timestamp>",
  "symbol": "TOKEN",
  "address": "0x...",
  "chain": "base",
  "action": "buy",
  "amount": 500,
  "percent_of_portfolio": 4,
  "tier": "moonshot",
  "entry_price": 0.001,
  "stop_loss": 0.0005,
  "take_profit_levels": "[{\"level\":1,\"price\":0.002,\"sellPercent\":50}]",
  "analysis_score": 76,
  "risk_score": 20,
  "reasoning": "..."
}'
```

**After writing a pending order (real mode), notify the human:**
```bash
node scripts/send-alert.js --type trade_proposal --agent research --message "BUY $TOKEN on base — $500 (4% moonshot) — score: 76. Reply to approve or reject."
```

The human approves or rejects via chat (orders skill). The Executor agent polls for approved orders every minute, validates independently, builds the Safe wallet transaction, signs, and submits. You do NOT execute trades directly — the Executor handles all wallet operations.

Check execution results later via:
```bash
# Real mode:  node scripts/db-query.js get-receipts --limit 5
# Paper mode: node scripts/db-query.js get-paper-receipts --limit 5
```

## Market Regime Awareness

Before sizing any position, read the current market regime:
```bash
node scripts/db-query.js get-meta --key market_regime
```

Apply regime-adjusted limits using `min(hard_limit, regime_limit)` for maximums and `max(hard_limit, regime_limit)` for minimums:

| Parameter | Bullish/Neutral | Bearish | Crisis |
|-----------|----------------|---------|--------|
| Min cash reserve | 10% | 25% | 40% |
| Base tier buying | Enabled | **Paused** | **Paused** |
| Max moonshot position | 5% | 3% | 0% (no new) |
| Max conviction position | 10% | 7% | 5% |
| Max moonshot allocation | 20% | 15% | 10% |
| Min buy score | 50 | 65 | 80 |

- In `bearish` or `crisis`: skip base tier rebalance buys entirely
- In `crisis`: reject all new moonshot positions (max = 0%)
- Always check that post-trade cash stays above the regime-adjusted minimum, not just the 10% hard floor

## Rules
- NEVER execute trades directly — the Executor agent handles all wallet operations
- NEVER exceed position limits (5% moonshot, 10% conviction, 50% base) — regime may lower these further
- NEVER let cash drop below regime-adjusted minimum (10% bullish/neutral, 25% bearish, 40% crisis)
- Minimum risk:reward ratio of 3:1
- Log every decision to daily memory
- The best trade is sometimes NO trade
