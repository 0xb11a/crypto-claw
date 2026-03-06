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
```bash
node scripts/check-contract.js --address <TOKEN_ADDRESS> --chain <CHAIN> --deep
```

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
2. Single wallet holds > 30% (excluding DEX/contract addresses)
3. Liquidity < $5,000
4. No liquidity lock AND contract not renounced
5. Known scam deployer address
6. Owner can pause transfers

### Step 4: Portfolio-Level Checks
- Would this push moonshot allocation above 20%?
- Are there already 3 positions in the same narrative?
- Would total positions exceed 15?
- Is portfolio already overexposed to this chain?

### Step 5: Verdict & Position Sizing
| Overall Risk | Verdict | Max Position |
|-------------|---------|-------------|
| 0-30 | `approve` | Up to 5% |
| 31-50 | `approve_with_caution` | Max 3% |
| 51-75 | `approve_with_caution` | Max 1% |
| 76+ | `reject` | 0% |

### Step 6: Output
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

### Step 7: Log & Handoff
- Write to `memory/YYYY-MM-DD.md` with `[RISK]` tag
- If verdict is not reject → pass to portfolio skill for trade proposal
- If verdict is reject → log the specific kill flag and end
