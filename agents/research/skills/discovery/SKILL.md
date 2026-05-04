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
- When smart-money wallets enter new positions

## Process

### Step 1: Check Market Regime
Read the current regime before scanning: `node scripts/db-query.js get-meta --key market_regime`

- **Crisis regime:** Skip moonshot scanning entirely (no new moonshot positions allowed). Run the conviction scan (Step 3) only when `narrative-check.js` shows at least one `hot` or `warming` narrative with `strong_conviction` or `lean_conviction` affinity — otherwise skip Step 3 this cycle.
- **Bearish regime:** Reduce scan limits (use `--limit 20` instead of 50), raise minimum liquidity filter (`--min-liquidity 20000` instead of 10000).
- **Bullish/Neutral:** Proceed normally.

### Step 2: Gather Data
Run the scanning script. The `--chain all` flag scans all active chains (controlled by `ACTIVE_CHAINS` env var, query via `get-chains`).

Bullish/Neutral — full scan across active chains:
```bash
node scripts/scan-tokens.js --chain all --sort trending --limit 50
```

Bearish — reduced scan:
```bash
node scripts/scan-tokens.js --chain all --sort trending --limit 20
```

Also check for new deployments on each active chain.

Bullish/Neutral — scan each active chain for newest tokens:
```bash
node scripts/scan-tokens.js --chain all --sort newest --min-liquidity 10000 --limit 30
```

Bearish — tighter filters:
```bash
node scripts/scan-tokens.js --chain all --sort newest --min-liquidity 20000 --limit 20
```

### Step 3: Scan for Conviction Candidates
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

### Step 4: Narrative-Guided Discovery

After trending and newest scans, check narrative momentum and run deep scans for hot/warming narratives:

```bash
# Get top 3 tokens per hot/warming narrative (lightweight agent mode)
node scripts/narrative-deep-scan.js --narrative all --hot-only --quick
```

Merge these results with trending/newest scan results. If a token appears in BOTH a trending scan AND a narrative deep scan, boost its urgency to `high` — it has both organic momentum and narrative tailwind.

**Momentum-aware strategy:**

| Narrative Momentum | Action | Position Sizing |
|--------------------|--------|----------------|
| **Hot** (>10% avg) | Active hunting. Prioritize speed to entry. | 100% of tier max |
| **Warming** (0–10%) | Selective. Look for catalyst-backed tokens. | 75% of tier max |
| **Cooling** (-10–0%) | No new entries. Flag existing positions in this narrative for portfolio-skill review (do NOT modify positions from discovery). Watchlist strong tokens. | 0% new |
| **Cold** (<-10%) | Exit-only for pure narrative plays. Hold tokens with fundamentals beyond narrative. | Exit weak positions |

### Step 5: Check Token Status (Dedup)
For each token in scan results, check if it needs analysis:
```bash
node scripts/db-query.js check-token-status --address <TOKEN_ADDRESS> --chain <CHAIN>
```
- `action: "skip"` → remove from batch, no further processing (already has position, pending order, watchlist entry, or recent cached analysis)
- `action: "analyze"` → keep for Step 6 filtering

This prevents redundant analysis of tokens that were already analyzed, have open positions, or are pending execution.

### Step 6: Initial Filter
From the raw results, apply these filters:

**Must-Have:**
- Liquidity > $10,000
- Contract verified on block explorer
- Holder count > 50 and growing
- At least one social presence (Twitter, Telegram, website)
- Launched within 72 hours OR showing >5x volume spike

**Strong Positive Signals:**
- Buy:sell ratio > 1.5
- Smart-money wallets entering — broader pre-trade scan (`db-query.js get-smart-money-signals --since 6h --action buy --chain <CHAIN> --group-by token --min-wallets 2`). Heartbeat consumption uses a 35-min window (jitter tolerance on a 30-min cadence); discovery uses 6 h for pre-trade context. Both windows are intentional — do not collapse them.
- Fits an active narrative (26 tracked — AI infra, AI agents, DeFi, restaking, LST, RWA, L2, ZK, modular, DePIN, memecoins, gaming, etc.)
- Dev wallet < 10% of supply
- Liquidity locked or burned

**Immediate Disqualify:**
- No verified contract
- Single wallet holds > 25%
- Liquidity < $5,000
- Deployer has rug history
- Token name copies a well-known project
- No social presence at all

### Step 7: Wallet Harvesting (Self-Seeding)
The background scorer (`score-wallets-bg.js`) self-seeds every 60 minutes by fetching Birdeye top 100 gainers for every active chain (~300 wallets/harvest). Scoring continues every 10 min. Additional sources:
- **Scoring pipeline**: Each `score-wallet.js` call also harvests token top traders (~50 per token scored)
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

The background scoring pipeline (`score-wallets-bg.js`) self-seeds from Birdeye leaderboards and picks up proposed wallets every 10 minutes, scoring them via Birdeye/Zerion APIs. Each scoring call also harvests token top traders (snowball effect). No need to wait — discovery can continue immediately.

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

### Step 8: Output
For each passing token, create a discovery entry:

```json
{
  "tokenAddress": "string",
  "chain": "<CHAIN>",
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

### Step 9: Log & Handoff
- Write discoveries to today's `memory/YYYY-MM-DD.md` with `[DISCOVERY]` tag
- Check MEMORY.md for any past patterns matching this token's profile
- If discoveries pass filter → proceed to analyst skill for deep analysis
- If nothing found → log "No discoveries this scan" and end

## Quality Standards
- Quality over quantity: 3 solid finds > 20 mediocre ones
- Every discovery must have a clear "reason" — never just list metrics
- Cross-reference against recent memory to avoid duplicates
- Be skeptical — false positives waste the entire pipeline's time

## Promotion
If a discovery pattern (e.g., a narrative, source, or signal that consistently surfaces strong tokens — or a recurring false-positive trap) recurs 3+ times across daily logs, promote it to `MEMORY.md` using the template in `AGENTS.md § MEMORY.md Updates`.

## Error Handling
Per AGENTS.md § Error Self-Reporting: if any scan or dedup step fails (scan-tokens.js crash, `check-token-status` error, narrative-deep-scan timeout, holder-distribution error) — log `add-research-log` with `status: "error"` and fire `send-alert.js --type model_failure --agent research`. Do not silently drop the affected tokens; a scan that returned no candidates is different from a scan that crashed.
