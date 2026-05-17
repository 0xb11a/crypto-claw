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

## Mandatory Pre-Flight (run before any portfolio action)
```bash
node scripts/db-query.js get-chains
```
(legacy hold-back — `cclaw system chains` pending P5) Read the active chains. Always include `--chain <chain>` on portfolio and cash commands.

## When to Use
- After risk skill approves a token
- When take-profit or stop-loss levels are hit
- When user requests portfolio review
- During scheduled rebalance checks

## Allocation Targets

Before sizing, run `get-chain-config --chain <CHAIN>` and read `tiersEnabled`. Only allocate to tiers the chain supports — if a tier is missing, redistribute its target to cash.

| Tier | Target (all tiers) | Target (no base tier) | Range |
|------|--------------------|-----------------------|-------|
| Conviction | 30% | 35% | 25–30% |
| Moonshot | 25% | 30% | 20–30% |
| Base | 25% | — | 20–30% |
| Cash | 15% | 30% | ≥ chain `minCashReserve` |

All allocation percentages are per-chain. Tier ranges are bounded above by the chain's `maxMoonshotAllocation` / `maxConvictionPosition` × position-count caps from `get-chain-config` — never propose past those. If `tiersEnabled` doesn't include the proposed tier, reject the trade.

## Entry Strategy — Scale In, Never Ape

| Tranche | % of Planned Position | Trigger |
|---------|----------------------|---------|
| Initial | 30-50% | Analysis + risk approval |
| Confirmation | 30-40% | Rising holders, volume, thesis confirmed |
| Final | 20-30% | Dip/consolidation (better entry) |

## Exit Strategy

### Moonshot Take-Profit & Stop-Loss
See AGENTS.md § Moonshot Take-Profit & Stop-Loss for the canonical table (TP1 2x/50%, TP2 4x/25%, TP3 8x/15%, moonbag 10%, SL -45%, time stop 5d). After TP1 → move SL to breakeven. After TP2 → activate 30% trailing stop.

### Conviction Take-Profit & Stop-Loss
See AGENTS.md § Conviction Take-Profit & Stop-Loss for the canonical table (TP1 1.5x/35%, TP2 2.5x/35%, TP3 4x/20%, moonbag 10%, SL -25%, time stop 10d reassess). After TP1 → move SL to breakeven. After TP2 → activate 20% trailing stop.

### Base Tier (Rebalancing, NOT TP/SL)
See `AGENTS.md § Base Tier Rebalancing` for the canonical trigger/action table. Use `maxBasePosition` from `get-chain-config --chain <CHAIN>` as the cap.

### Regime Exit Adjustments (apply at order creation)
See `AGENTS.md § Regime Exit Adjustments` for the multiplier table. Apply at order creation; existing positions keep their stored levels.

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
1. Run `cclaw positions list --chain <chain>` and `node scripts/db-query.js get-cash --chain <chain>` (get-cash is legacy hold-back)
2. Calculate current vs target allocation
3. Identify overweight/underweight tiers
4. Propose specific sells (weakest positions in overweight tier)
5. Propose specific buys or cash retention for underweight tier:
   - **If base tier is underweight:** Base tier buys are restricted to wrapped native tokens only. Never classify or propose a non-native token as base tier to fill an underweight base allocation. If no base token is available or appropriate, leave the allocation underweight and allocate to cash instead. Query `get-chain-config --chain <CHAIN>` for `baseTierTokens`. These are the only tokens eligible for base tier allocation on each chain. Propose buying the most underweight base asset from that list. Prefer spreading across multiple base assets when available on the same chain to improve diversification. Use `node scripts/token-metrics.js --address <BASE_TOKEN_ADDRESS> --chain <CHAIN>` to get current price.

   - **If conviction tier is underweight:** Check watchlist and recent analyses for conviction-rated tokens, or trigger a conviction scan via `node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30`
   - **If moonshot tier is underweight:** Normal discovery pipeline handles this
6. Write the orders via `add-order` (it returns `{status, approved_by}`). If any return `status: pending`, send the rebalance proposal to the human:
   ```bash
   node scripts/send-alert.js --type rebalance_event --agent research --message "Rebalance proposed on <CHAIN>: sell overweight <TIER>, buy underweight <TIER>. X orders pending approval."
   ```

## Writing Orders to Database

After formatting the trade proposal, write the order via `add-order`. It returns `{status, approved_by}` — branch on the returned `status`:
- `approved` → Executor will pick it up next minute. No approval call needed.
- `pending` → human approval required. Call `send-approval.js` (below) to surface inline buttons.

```bash
cclaw orders propose --json '{"id":"trade-<timestamp>","symbol":"TOKEN","address":"0x...","chain":"<CHAIN>","action":"buy","amount":500,"percent_of_portfolio":4,"tier":"moonshot","entry_price":0.001,"stop_loss":0.0005,"take_profit_levels":[{"level":1,"price":0.002,"sellPercent":50}],"analysis_score":76,"risk_score":20,"reasoning":"..."}'
```

**After writing an order, always notify the human:**
```bash
# Text notification (all orders — pending and auto-approved):
node scripts/send-alert.js --type trade_proposal --agent research --message "BUY $TOKEN on <CHAIN> — $500 (4% moonshot) — score: 76"
```

**For pending orders, also send interactive approval buttons:**
```bash
node scripts/send-approval.js --order-id trade-<timestamp>
```
This sends the trade proposal to Telegram with inline Approve/Reject buttons. Only works when `TELEGRAM_APPROVAL_BOT_TOKEN` is configured (gracefully skips otherwise). Human can also approve via chat (orders skill) or CLI as before.

The human approves or rejects via chat (orders skill). The Executor agent polls for approved orders every minute, validates independently, builds the Safe wallet transaction, signs, and submits. You do NOT execute trades directly — the Executor handles all wallet operations.

Check execution results later via `cclaw receipts list --limit 5`.

## Market Regime Awareness

Before sizing any position, read the current market regime:
```bash
node scripts/db-query.js get-meta --key market_regime
```
(legacy hold-back)

Apply regime-adjusted limits using `min(chainRule, regimeLimit)` for maximums and `max(chainRule, regimeLimit)` for minimums. See `AGENTS.md § Market Regime Adjustments` for the full parameter table.

- In `bearish` or `crisis`: skip base tier rebalance buys entirely
- In `crisis`: reject all new moonshot positions (max = 0%)
- Always check that post-trade cash stays above the regime-adjusted minimum, not just the chain's `minCashReserve` hard floor

## Rules
- NEVER execute trades directly — the Executor agent handles all wallet operations
- NEVER exceed chain-specific position limits (read `rules` from `get-chain-config --chain <CHAIN>`) — regime may lower these further
- NEVER let cash drop below regime-adjusted minimum (chain `minCashReserve` bullish/neutral, 25% bearish, 40% crisis)
- Minimum reward:risk ratio: enforce per `AGENTS.md § Per-Trade Hard Floor — Reward:Risk Ratio` (3:1, applies to all tiers in all regimes).
- Log every decision to daily memory
- Prefer no trade over a marginal one — if both the analysis score and the risk verdict land in borderline territory (analysis 50–55, risk 40–50), log to watchlist and move on instead of proposing

## Promotion
If a portfolio pattern (e.g., a regime-specific outcome, recurring rebalance trigger, or sizing decision that consistently helps or hurts P&L) recurs 3+ times across daily logs, promote it to `MEMORY.md` using the template in `AGENTS.md § MEMORY.md Updates`.

## Error Handling
Per AGENTS.md § Error Self-Reporting:
- If `get-portfolio` / `get-cash` / `get-chain-config` fails: log `status: "error"` to research_log, fire `send-alert.js --type model_failure --agent research`, halt the proposal. You cannot size safely without current allocation state.
- If `add-order` fails: log `status: "error"` and alert immediately — a proposal that was analyzed but never written to the orders table is the orphan case Observer looks for.
- If `send-approval.js` errors (approval bot misconfigured or offline), treat as `warn`, not `error` — the order is still in the DB and can be approved via chat or CLI.
