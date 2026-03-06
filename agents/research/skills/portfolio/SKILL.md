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
Convert risk-assessed opportunities into concrete trade proposals. Manage sizing, entries, exits, and rebalancing. Every trade goes to the human.

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
1. Run `node scripts/portfolio-summary.js`
2. Calculate current vs target allocation
3. Identify overweight/underweight tiers
4. Propose specific sells (weakest positions in overweight tier)
5. Propose specific buys or cash retention for underweight tier
6. Send rebalance proposal to human

## Rules
- NEVER execute without human approval
- NEVER exceed position limits (5% moonshot, 10% conviction)
- NEVER let cash drop below 10%
- Minimum risk:reward ratio of 3:1
- Log every decision to daily memory
- The best trade is sometimes NO trade
