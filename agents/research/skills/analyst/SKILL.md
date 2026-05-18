---
name: analyst
description: Deep fundamental analysis and scoring of discovered tokens
triggers:
  - analyze token
  - evaluate token
  - deep dive
  - score this token
  - what do you think about
  - analysis
---

> **Note:** This skill requires deep reasoning. Gather all available data (contract snapshots via `cclaw contracts list`, scored wallets via `cclaw wallets list`, current portfolio, relevant memory patterns) before executing.

# Analyst Skill

## Purpose
Evaluate every token discovery on fundamentals, tokenomics, social sentiment, narrative fit, and timing. Produce a scored assessment.

## When to Use
- After discovery skill finds new tokens
- When user asks to analyze a specific token
- When reassessing an existing position

## Process

### Step 1: Gather Deep Data

[cclaw expansion pending P5b — `token-metrics.js`, `check-contract.js`, and `holder-distribution.js` deleted in P5; `cclaw analysis token-metrics`, `cclaw analysis contract-check`, and `cclaw analysis holder-distribution` not yet implemented. Use available on-chain data from your context for fundamentals analysis.]

Get contract snapshots (cached GoPlus safety data; may be stale if ContractSafetyProcessor hasn't run for this token):
```bash
cclaw contracts list --address <TOKEN_ADDRESS> --chain <CHAIN>
```

> **Two-source confirmation:** the executor enforces, at signing time, that BOTH DEXScreener and Birdeye see the token and agree on price within 2%. Tokens that fail this gate are auto-quarantined with a Telegram alert. You don't need to verify two-source agreement during analysis — the gate fires regardless — but if you find a token that DEXScreener has and Birdeye doesn't, expect quarantine.

> **Recovered safety rejections:** when a structural reject occurs (*not fungible*, *not a token*, *no holder data*), this is a cached avoid decision. Cache the verdict via `cclaw analysis cache --json '{"verdict":"avoid","reason":"<reason>",...}'` and log to `cclaw logs research append` with `"status":"warning"` (NOT `"error"`). Reserve `status:"error"` for unrecovered crashes.

Holder distribution snapshots (scored wallets associated with this token's deployer/holders):
```bash
cclaw wallets list --status scored
```

### Step 2: Score Across 6 Dimensions

**Contract Safety (Weight: 25%)**
| Signal | Points |
|--------|--------|
| Verified + renounced | 90-100 |
| Verified, not renounced but multisig | 70-85 |
| Verified, single owner | 40-60 |
| Unverified | 0-20 |
| Mint function present | -20 |
| Proxy/upgradeable | -15 |
| Audit by known firm | +15 |

**Tokenomics (Weight: 20%)**
| Signal | Points |
|--------|--------|
| Top 10 wallets < 30% | 80-100 |
| Top 10 wallets 30-50% | 40-70 |
| Top 10 wallets > 50% | 0-30 |
| Team allocation < 10% with lock | +15 |
| Deflationary mechanics | +10 |
| Clear vesting schedule | +10 |

**Liquidity (Weight: 20%)**
| Signal | Points |
|--------|--------|
| LP locked > 6 months | 85-100 |
| LP locked 1-6 months | 60-80 |
| LP burned | 90-100 |
| LP not locked | 0-30 |
| Liquidity:MCap ratio > 10% | +15 |
| Liquidity > $100k | +10 |

**Social & Community (Weight: 15%)**
| Signal | Points |
|--------|--------|
| Organic community, active devs | 80-100 |
| Good community, quiet devs | 50-70 |
| Mostly bots / paid shills | 0-30 |
| Influencer mentions (organic) | +10 |
| Influencer mentions (paid only) | -10 |

**Narrative Fit (Weight: 10%)**

26 narratives tracked (see MEMORY.md for current narrative tracking): ai_infra, ai_agents, defi, restaking, lst, yield, payfi, rwa, prediction, l2, zk, modular, intents, depin, memecoin, socialfi, gaming, nft_infra, btc_eco, btc_l2, privacy, telegram, consumer, desci, degov, energy.

| Signal | Points |
|--------|--------|
| Leading token in hot narrative | 90-100 |
| Solid token in active narrative | 60-80 |
| Narrative cooling down | 30-50 |
| No clear narrative | 0-20 |

Apply the tier affinity boost from the "Narrative score modifier" subsection of Step 4 on top of the base score (cap at 100).

**Timing (Weight: 10%)**
| Signal | Points |
|--------|--------|
| Early (< 24h, metrics growing) | 85-100 |
| Mid (1-7d, momentum building) | 60-80 |
| Late (> 7d, price already 5x+) | 20-40 |
| Volume trend increasing | +10 |
| At support level | +10 |

### Step 3: Calculate Weighted Score
```
overall = (contract * 0.25) + (tokenomics * 0.20) + (liquidity * 0.20) +
          (social * 0.15) + (narrative * 0.10) + (timing * 0.10)
```

### Step 4: Assign Tier

Based on token characteristics AND narrative context, assign the appropriate portfolio tier.

#### Base tier check

| Criteria | Tier |
|----------|------|
| Token address matches any entry in `baseTierTokens` from `cclaw system chain-config --chain <CHAIN>` AND `base` is in the chain's `tiersEnabled` | `base` |

**Base tier is a closed set.** ONLY the tokens listed in `baseTierTokens` from `cclaw system chain-config` can be base tier. No other token — regardless of liquidity, age, market cap, or how underweight the base allocation is — may be classified as base. If a token is not in `baseTierTokens`, or if `base` is not in the chain's `tiersEnabled`, proceed to the narrative-aware assignment below.

#### Narrative-aware tier assignment

Each narrative has a tier affinity (listed below). Use this decision tree:

```
Is tierAffinity "strong_moonshot"?
  → Always moonshot. Volatility too high for conviction sizing.
    Narratives: memecoin, socialfi, telegram, desci, energy, degov

Is tierAffinity "lean_moonshot"?
  → Default moonshot. Only conviction if EXCEPTIONAL:
    age >30 days AND liquidity >$500k
    Narratives: ai_agents, gaming, btc_eco, btc_l2, nft_infra, intents, consumer

Does token meet conviction criteria?
  (age >7d, liquidity >$100k, mcap >$1M, verified + renounced/multisig)

  YES + affinity "strong_conviction" or "lean_conviction"?
    → conviction
    Narratives: defi, lst, restaking, rwa, l2, zk, modular,
                ai_infra, yield, depin, payfi, prediction, privacy

  YES + affinity "lean_moonshot"?
    → moonshot (unless exceptional as above)

  NO → moonshot
```

#### Narrative score modifier

When narrative is hot or warming, apply a boost to the narrative fit dimension score:

| Tier Affinity | Narrative Score Boost |
|---------------|----------------------|
| `strong_conviction` | +15 when hot/warming |
| `lean_conviction` | +10 when hot/warming |
| `lean_moonshot` | +5 when hot |
| `strong_moonshot` | +0 (no boost) |

The tier determines position limits, stop-loss levels, and slippage tolerance.

### Step 5: Recommendation
| Score | Recommendation |
|-------|---------------|
| 71-100 | `strong_buy` — high conviction, act soon |
| 51-70 | `buy` — solid opportunity |
| 31-50 | `watch` — interesting, wait for better entry |
| 0-30 | `avoid` — too many red flags |

### Step 6: Output Format
```json
{
  "tokenAddress": "string",
  "chain": "string",
  "symbol": "string",
  "scores": {
    "contract": 0,
    "tokenomics": 0,
    "liquidity": 0,
    "social": 0,
    "narrative": "string",
    "narrativeScore": 0,
    "timing": 0,
    "overall": 0
  },
  "strengths": ["string"],
  "weaknesses": ["string"],
  "recommendation": "strong_buy | buy | watch | avoid",
  "tier": "base | conviction | moonshot",
  "suggestedEntry": 0,
  "suggestedSize": "small | medium | large",
  "reasoning": "2-3 sentence summary"
}
```

### Step 7: Log & Handoff
- Write to `memory/YYYY-MM-DD.md` with `[ANALYSIS]` tag
- Check MEMORY.md for similar past analyses and their outcomes
- If recommendation is buy or strong_buy → proceed to risk skill
- If watch → add to watchlist via database:
  ```bash
  cclaw watchlist add --json '{"symbol":"TOKEN","address":"0x...","chain":"<CHAIN>","reason":"...","target_entry":0.001}'
  ```
- If avoid → cache the result and end:
  ```bash
  cclaw analysis cache --json '{"address":"<TOKEN_ADDRESS>","chain":"<CHAIN>","symbol":"<SYMBOL>","analysis_score":<SCORE>,"verdict":"avoid","reasoning":"<REASON>"}'
  ```

## Rules
- NEVER let excitement override analysis
- If something looks too good, look harder for the catch
- Acknowledge uncertainty — if you can't verify something, adjust score down
- Compare against alternatives in the same narrative
- Always suggest a specific entry price, not just "buy"

## Promotion
If an analysis pattern (e.g., a scoring heuristic, token archetype, or recurring outcome correlation between metrics and post-trade results) recurs 3+ times across daily logs, promote it to `MEMORY.md` using the template in `AGENTS.md § MEMORY.md Updates`.
