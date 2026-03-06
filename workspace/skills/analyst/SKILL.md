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

# Analyst Skill

## Purpose
Evaluate every token discovery on fundamentals, tokenomics, social sentiment, narrative fit, and timing. Produce a scored assessment.

## When to Use
- After discovery skill finds new tokens
- When user asks to analyze a specific token
- When reassessing an existing position

## Process

### Step 1: Gather Deep Data
```bash
# Get full token metrics
node scripts/token-metrics.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check contract safety
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN>

# Check holder distribution
node scripts/holder-distribution.js --address <TOKEN_ADDRESS> --chain <CHAIN>
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
| Signal | Points |
|--------|--------|
| Leading token in hot narrative | 90-100 |
| Solid token in active narrative | 60-80 |
| Narrative cooling down | 30-50 |
| No clear narrative | 0-20 |

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

### Step 4: Recommendation
| Score | Recommendation |
|-------|---------------|
| 71-100 | `strong_buy` — high conviction, act soon |
| 51-70 | `buy` — solid opportunity |
| 31-50 | `watch` — interesting, wait for better entry |
| 0-30 | `avoid` — too many red flags |

### Step 5: Output Format
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
  "suggestedEntry": 0,
  "suggestedSize": "small | medium | large",
  "reasoning": "2-3 sentence summary"
}
```

### Step 6: Log & Handoff
- Write to `memory/YYYY-MM-DD.md` with `[ANALYSIS]` tag
- Check MEMORY.md for similar past analyses and their outcomes
- If recommendation is buy or strong_buy → proceed to risk skill
- If watch → add to watchlist in daily memory
- If avoid → log reason and end

## Rules
- NEVER let excitement override analysis
- If something looks too good, look harder for the catch
- Acknowledge uncertainty — if you can't verify something, adjust score down
- Compare against alternatives in the same narrative
- Always suggest a specific entry price, not just "buy"
