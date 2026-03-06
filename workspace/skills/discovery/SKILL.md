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

### Step 1: Gather Data
Run the scanning script:
```bash
node scripts/scan-tokens.js --chain all --sort trending --limit 50
```

Also check for new deployments:
```bash
node scripts/scan-tokens.js --chain solana --sort newest --min-liquidity 10000 --limit 30
node scripts/scan-tokens.js --chain base --sort newest --min-liquidity 10000 --limit 30
```

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
