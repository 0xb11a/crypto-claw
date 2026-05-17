---
name: risk
description: Risk assessment and safety check before any trade proposal
triggers:
  - risk check
  - assess risk
  - is this safe
  - risk score
  - safety check
  - should I buy
---

> **Note:** This skill requires deep reasoning. Gather all data (check-contract --deep output, analysis results, current portfolio/positions, market regime) before executing.

# Risk Skill

## Purpose
Last line of defense before capital is committed. Be paranoid. Better to miss a 10x than lose 100% on a rug.

## Mindset
- Assume every token is a scam until proven otherwise
- Challenge the analyst's optimism — your job is to find danger
- Think in portfolios — one bad position shouldn't sink the ship

## When to Use
- ALWAYS before proposing any trade (mandatory step)
- When analyst rates a token buy or strong_buy
- When reassessing existing positions
- When user asks "is this safe?"

## Process

### Step 1: Contract Deep Scan
[cclaw expansion pending P5b — `check-contract.js` deleted in P5; `cclaw analysis contract-check` not yet implemented. Use cached contract snapshot from db-query hold-back:]
```bash
node scripts/db-query.js get-contract-snapshots --address <TOKEN_ADDRESS> --chain <CHAIN>
```
(legacy hold-back — cached GoPlus data; if empty, this token hasn't been scanned by ContractSafetyProcessor yet)

### Step 2: Score Risk (0-100, higher = riskier)

**Contract Risk**
| Signal | Risk Score |
|--------|-----------|
| Honeypot detected | +50 (AUTO-REJECT) |
| Proxy/upgradeable | +30 |
| Mint function | +25 |
| Hidden fees (>10%) | +20 |
| Not verified | +40 |
| Not renounced | +15 |
| Fresh deployer (<10 txs) | +15 |
| Owner can pause | +25 (AUTO-REJECT) |

**Liquidity Risk**
| Signal | Risk Score |
|--------|-----------|
| Liquidity < $5k | AUTO-REJECT |
| Liquidity < $10k | +30 |
| Liquidity < $50k | +15 |
| No LP lock/burn | +25 |
| LP lock < 30 days | +15 |
| Single LP provider | +20 |
| Slippage > 5% at position size | +20 |

**Concentration Risk**
| Signal | Risk Score |
|--------|-----------|
| Top wallet > 30% | AUTO-REJECT |
| Top wallet > 20% | +30 |
| Top 10 wallets > 50% | +25 |
| Snipers holding > 15% | +20 |
| Team wallet unlocked | +15 |

**Social Risk**
| Signal | Risk Score |
|--------|-----------|
| >30% bot followers | +25 |
| Only paid promotion | +20 |
| No organic community | +15 |
| Anonymous dev, no track record | +10 |
| Name copies existing project | +20 |

**Narrative Risk**
| Signal | Risk Score |
|--------|-----------|
| Narrative peaking | +30 |
| Too many competing tokens | +15 |
| Single-catalyst dependency | +20 |
| No clear narrative | +10 |

### Step 3: Auto-Reject Conditions (NON-NEGOTIABLE)
If ANY of these are true → immediate REJECT, no exceptions:
1. Honeypot contract pattern
2. Single wallet holds > 30% of supply (excluding DEX/contract addresses)
3. Liquidity < $5,000
4. No liquidity lock AND contract not renounced
5. Known scam deployer address
6. Owner can pause transfers

### Step 4: Regime Risk-Score Penalty
Read the current market regime: `node scripts/db-query.js get-meta --key market_regime` (legacy hold-back)

Apply regime-based risk score adjustments (base tier tokens are exempt — their buying is gated separately in the heartbeat):

| Regime | Moonshot modifier | Conviction modifier |
|--------|------------------|---------------------|
| Bullish/Neutral | +0 | +0 |
| Bearish | +15 | +10 |
| Crisis | +30 | +20 |

Add the modifier to the overall risk score calculated in Step 2. This makes it harder for tokens to pass the risk threshold during downturns.

In `crisis` regime: if tier is `moonshot`, auto-reject (max position = 0%).

### Step 5: Portfolio-Level Checks
Use `get-portfolio --chain <chain>` and `get-positions` — both auto-route to the deployment's table set.

Read the target chain's portfolio rules via `get-chain-config --chain <CHAIN>`. All checks below use the chain-specific limits, not global defaults.

- Would this push moonshot allocation above the chain's `maxMoonshotAllocation`?
- Would this push conviction allocation above the chain's `maxConvictionPosition` * position count?
- Are there already `maxSameNarrative` positions in the same narrative on this chain?
- Would total positions on this chain exceed `maxOpenPositions`?
- Is the proposed tier in the chain's `tiersEnabled`? If not, reject.
- **For base tier:** Simplified risk check — established assets skip contract/social/narrative risk scoring. Focus on portfolio allocation limits and entry timing (reject if price >20% above 7-day average).

### Step 6: Verdict & Position Sizing

Load the chain's `rules` from `get-chain-config --chain <CHAIN>` and use `maxMoonshotPosition` / `maxConvictionPosition` as the tier cap for that chain.

| Overall Risk | Verdict | Max Position |
|-------------|---------|-------------|
| 0-30 | `approve` | Up to chain tier cap |
| 31-50 | `approve_with_caution` | Max 3% |
| 51-75 | `approve_with_caution` | Max 1% |
| 76+ | `reject` | 0% |

Cap `maxPositionPercent` at the regime-adjusted limit for the token's tier:
- Moonshot: `min(maxPositionPercent, regimeMaxMoonshot)` — chain `maxMoonshotPosition` bullish/neutral, 3% bearish, 0% crisis
- Conviction: `min(maxPositionPercent, regimeMaxConviction)` — chain `maxConvictionPosition` bullish/neutral, 7% bearish, 5% crisis

### Step 7: Output
```json
{
  "tokenAddress": "string",
  "symbol": "string",
  "riskScores": {
    "contract": 0,
    "liquidity": 0,
    "concentration": 0,
    "social": 0,
    "narrative": 0,
    "overall": 0
  },
  "flags": [
    {"type": "string", "severity": "critical|high|medium|low", "description": "string"}
  ],
  "verdict": "approve | approve_with_caution | reject",
  "maxPositionPercent": 0,
  "reasoning": "string"
}
```

### Step 8: Log & Handoff
- Write to `memory/YYYY-MM-DD.md` with `[RISK]` tag
- If verdict is not reject → pass to portfolio skill for trade proposal
- If verdict is reject → cache the rejection and end:
  ```bash
  node scripts/db-query.js cache-analysis --json '{"address":"<TOKEN_ADDRESS>","chain":"<CHAIN>","symbol":"<SYMBOL>","analysis_score":<ANALYSIS_SCORE>,"risk_score":<RISK_SCORE>,"verdict":"risk_rejected","reasoning":"<REASON>"}'
  ```
  (legacy hold-back)

## Promotion
If a risk pattern (e.g., a recurring red-flag combination, deployer signature, or contract behavior that consistently precedes losses) recurs 3+ times across daily logs, promote it to `MEMORY.md` using the template in `AGENTS.md § MEMORY.md Updates`.
