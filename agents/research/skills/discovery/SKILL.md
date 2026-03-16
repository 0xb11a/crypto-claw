---
name: discovery
description: Scan chains and DEX aggregators for new high-potential tokens
triggers:
  - scan for tokens
  - find new tokens
  - what's trending
  - new launches
  - discovery scan
  - token hunt
---

# Discovery Skill

## Purpose
Find new, high-potential crypto tokens before the crowd. You are the system's eyes and ears.

## When to Use
- During scheduled heartbeat scans
- When user asks "what's new" or "scan for tokens"
- When narrative agent detects a trending theme
- When smart money wallets enter new positions

## Process

### Step 0: Check Market Regime
Read the current regime before scanning: `node scripts/db-query.js get-meta --key market_regime`

- **Crisis regime:** Skip moonshot scanning entirely (no new moonshot positions allowed). Only run conviction scans (Step 1b) if there are clear opportunities.
- **Bearish regime:** Reduce scan limits (use `--limit 20` instead of 50), raise minimum liquidity filter (`--min-liquidity 20000` instead of 10000).
- **Bullish/Neutral:** Proceed normally.

### Step 1: Gather Data
Run the scanning script:
```bash
# Bullish/Neutral: full scan
node scripts/scan-tokens.js --chain all --sort trending --limit 50

# Bearish: reduced scan
node scripts/scan-tokens.js --chain all --sort trending --limit 20
```

Also check for new deployments:
```bash
# Bullish/Neutral: standard limits
node scripts/scan-tokens.js --chain solana --sort newest --min-liquidity 10000 --limit 30
node scripts/scan-tokens.js --chain base --sort newest --min-liquidity 10000 --limit 30

# Bearish: tighter filters
node scripts/scan-tokens.js --chain solana --sort newest --min-liquidity 20000 --limit 20
node scripts/scan-tokens.js --chain base --sort newest --min-liquidity 20000 --limit 20
```

### Step 1b: Scan for Conviction Candidates
Run established token scan to find conviction-tier opportunities:
```bash
node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30
```

Apply conviction-specific filters:
- Age > 7 days (not brand new)
- Liquidity > $100,000
- Volume > $50k/24h (real trading activity)
- Contract verified with renounced or multisig ownership
- Active development or community

These feed into the same analysis pipeline but will be assigned conviction tier by the analyst.

### Step 1.5: Check Token Status (Dedup)
For each token in scan results, check if it needs analysis:
```bash
node scripts/db-query.js check-token-status --address <TOKEN_ADDRESS> --chain <CHAIN>
```
- `action: "skip"` → remove from batch, no further processing (already has position, pending order, watchlist entry, or recent cached analysis)
- `action: "analyze"` → keep for Step 2 filtering

This prevents redundant Sonnet sub-agent spawns on tokens that were already analyzed, have open positions, or are pending execution.

### Step 2: Initial Filter
From the raw results, apply these filters:

**Must-Have:**
- Liquidity > $10,000
- Contract verified on block explorer
- Holder count > 50 and growing
- At least one social presence (Twitter, Telegram, website)
- Launched within 72 hours OR showing >5x volume spike

**Strong Positive Signals:**
- Buy:sell ratio > 1.5
- Smart money wallets entering (check `scripts/check-wallets.js`)
- Fits an active narrative (AI, RWA, DePIN, etc.)
- Dev wallet < 10% of supply
- Liquidity locked or burned

**Immediate Disqualify:**
- No verified contract
- Single wallet holds > 25%
- Liquidity < $5,000
- Deployer has rug history
- Token name copies a well-known project
- No social presence at all

### Step 2b: Wallet Harvesting (Mostly Automatic)
Wallets are now harvested automatically from two sources — no manual action needed for most cases:
- **Scoring pipeline**: Each `score-wallet.js` call auto-proposes ~100 wallets from Birdeye leaderboard + ~50 from token top traders
- **Holder analysis**: When you call `holder-distribution.js` with `--propose`, top 5 non-contract holders are auto-proposed

**Always use `--propose` when calling holder-distribution.js:**
```bash
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN> --propose
```

**For deployer wallets from check-contract.js**, propose manually:
```bash
node scripts/db-query.js propose-wallet --json '{
  "address": "<DEPLOYER_ADDRESS>",
  "chain": "<CHAIN>",
  "label": "Deployer of TOKEN",
  "source_token": "<TOKEN_ADDRESS>"
}'
```

The background scoring pipeline (`score-wallets-bg.js`) picks up proposed wallets every 10 minutes and scores them via Birdeye/Zerion APIs. Each scoring call harvests more wallets (snowball effect). No need to wait — discovery can continue immediately.

**For high-priority wallets** (e.g., wallet appears in 3+ discovered tokens), score immediately:
```bash
node scripts/score-wallet.js --address <WALLET_ADDRESS> --chain <CHAIN> --add --label "Multi-token holder"
```

**Classifications (set by background scorer):**
| Score | Classification | Action |
|-------|---------------|--------|
| 75+ | `smart_money` | Auto-tracked, high signal |
| 55-74 | `whale` | Auto-tracked, monitor |
| 35-54 | `trader` | Tracked if appears in multiple tokens |
| 0-34 | `retail` | Not monitored |

### Step 3: Output
For each passing token, create a discovery entry:

```json
{
  "tokenAddress": "string",
  "chain": "ethereum | solana | base | arbitrum",
  "symbol": "string",
  "name": "string",
  "price": "number",
  "liquidity": "number",
  "volume24h": "number",
  "holders": "number",
  "holdersChange24h": "number",
  "buyCount24h": "number",
  "sellCount24h": "number",
  "topHolderPercent": "number",
  "contractVerified": "boolean",
  "liquidityLocked": "boolean",
  "narrative": "string",
  "reason": "string — why this token stands out",
  "urgency": "high | medium | low"
}
```

### Step 4: Log & Handoff
- Write discoveries to today's `memory/YYYY-MM-DD.md` with `[DISCOVERY]` tag
- Check MEMORY.md for any past patterns matching this token's profile
- If discoveries pass filter → proceed to analyst skill for deep analysis
- If nothing found → log "No discoveries this scan" and end

## Quality Standards
- Quality over quantity: 3 solid finds > 20 mediocre ones
- Every discovery must have a clear "reason" — never just list metrics
- Cross-reference against recent memory to avoid duplicates
- Be skeptical — false positives waste the entire pipeline's time
