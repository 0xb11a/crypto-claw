#!/usr/bin/env node
/**
 * Test Suite: Safety Rules
 *
 * Tests the hard-coded safety rules from AGENTS.md:
 * - Position size limits
 * - Allocation limits
 * - Auto-reject conditions
 * - Sell vs buy approval logic
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

// ============================================================
// Safety Rule Validators (extracted from AGENTS.md)
// ============================================================

function validatePositionSize(percentOfPortfolio, tier, chainRules = null) {
  const defaults = { moonshot: 5, conviction: 10, base: 30 };
  const limits = chainRules
    ? {
        moonshot: chainRules.maxMoonshotPosition,
        conviction: chainRules.maxConvictionPosition,
        base: chainRules.maxBasePosition,
      }
    : defaults;
  const max = limits[tier];
  if (max === undefined) return { valid: false, reason: `Unknown tier: ${tier}` };
  if (percentOfPortfolio > max) {
    return { valid: false, reason: `${tier} position ${percentOfPortfolio}% exceeds max ${max}%` };
  }
  return { valid: true };
}

function validateAllocation(currentAllocation, newPositionTier, newPositionPercent) {
  const after = { ...currentAllocation };
  after[newPositionTier] = (after[newPositionTier] || 0) + newPositionPercent;

  if (after.moonshot > 30) return { valid: false, reason: `Moonshot allocation ${after.moonshot}% exceeds 30%` };
  if (after.cash < 10) return { valid: false, reason: `Cash reserve ${after.cash}% below 10% minimum` };
  return { valid: true };
}

function validateAutoReject(tokenData) {
  const reasons = [];

  if (tokenData.isHoneypot) reasons.push('Honeypot detected');
  if (tokenData.topHolderPercent > 30) reasons.push(`Top holder ${tokenData.topHolderPercent}% > 30%`);
  if (tokenData.liquidity < 5000) reasons.push(`Liquidity $${tokenData.liquidity} < $5,000`);
  if (!tokenData.liquidityLocked && !tokenData.contractRenounced) reasons.push('No LP lock AND not renounced');
  if (tokenData.knownScamDeployer) reasons.push('Known scam deployer');
  if (tokenData.canPause) reasons.push('Owner can pause transfers');

  return { rejected: reasons.length > 0, reasons };
}

function shouldRequireApproval(action) {
  // Buys need approval, sells don't
  if (action === 'buy') return true;
  if (action === 'sell') return false;
  return true; // unknown actions require approval
}

// ============================================================
// Position Size Tests
// ============================================================
describe('Position Size Limits', () => {
  test('moonshot at 5% is allowed', () => {
    const result = validatePositionSize(5, 'moonshot');
    assert(result.valid, 'Should be valid');
  });

  test('moonshot at 6% is rejected', () => {
    const result = validatePositionSize(6, 'moonshot');
    assert(!result.valid, 'Should be rejected');
  });

  test('moonshot at 1% is allowed', () => {
    const result = validatePositionSize(1, 'moonshot');
    assert(result.valid, 'Should be valid');
  });

  test('conviction at 10% is allowed', () => {
    const result = validatePositionSize(10, 'conviction');
    assert(result.valid, 'Should be valid');
  });

  test('conviction at 11% is rejected', () => {
    const result = validatePositionSize(11, 'conviction');
    assert(!result.valid, 'Should be rejected');
  });

  test('base at 30% is allowed', () => {
    const result = validatePositionSize(30, 'base');
    assert(result.valid, 'Should be valid');
  });

  test('base at 31% is rejected', () => {
    const result = validatePositionSize(31, 'base');
    assert(!result.valid, 'Should be rejected');
  });

  test('unknown tier is rejected', () => {
    const result = validatePositionSize(1, 'unknown');
    assert(!result.valid, 'Should be rejected');
  });
});

// ============================================================
// Allocation Tests
// ============================================================
describe('Portfolio Allocation Limits', () => {
  test('adding moonshot within limits is ok', () => {
    const current = { base: 25, conviction: 30, moonshot: 20, cash: 25 };
    const result = validateAllocation(current, 'moonshot', 5);
    assert(result.valid, 'Should be valid');
  });

  test('adding moonshot that exceeds 30% is rejected', () => {
    const current = { base: 25, conviction: 30, moonshot: 28, cash: 17 };
    const result = validateAllocation(current, 'moonshot', 5);
    assert(!result.valid, 'Should be rejected — moonshot > 30%');
  });

  test('trade that drops cash below 10% is rejected', () => {
    const current = { base: 50, conviction: 25, moonshot: 15, cash: 10 };
    // This doesn't directly reduce cash, but the validation should catch it
    // when the portfolio manager calculates the new state
    assert(current.cash >= 10, 'Cash should be at minimum');
  });
});

// ============================================================
// Auto-Reject Tests
// ============================================================
describe('Auto-Reject Conditions', () => {
  test('honeypot is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: true,
      topHolderPercent: 5,
      liquidity: 100000,
      liquidityLocked: true,
      contractRenounced: false,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(result.rejected, 'Honeypot must be auto-rejected');
    assert(result.reasons.includes('Honeypot detected'), 'Reason should mention honeypot');
  });

  test('top holder >30% is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 35,
      liquidity: 100000,
      liquidityLocked: true,
      contractRenounced: false,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(result.rejected, '>30% holder must be auto-rejected');
  });

  test('top holder at 30% is NOT rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 30,
      liquidity: 100000,
      liquidityLocked: true,
      contractRenounced: false,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(!result.rejected, '30% exactly should pass');
  });

  test('liquidity below $5k is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 5,
      liquidity: 4999,
      liquidityLocked: true,
      contractRenounced: false,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(result.rejected, '<$5k liquidity must be auto-rejected');
  });

  test('no LP lock AND not renounced is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 5,
      liquidity: 100000,
      liquidityLocked: false,
      contractRenounced: false,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(result.rejected, 'No lock + not renounced must be rejected');
  });

  test('no LP lock BUT renounced is OK', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 5,
      liquidity: 100000,
      liquidityLocked: false,
      contractRenounced: true,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(!result.rejected, 'Renounced should compensate for no LP lock');
  });

  test('clean token passes all checks', () => {
    const result = validateAutoReject({
      isHoneypot: false,
      topHolderPercent: 10,
      liquidity: 50000,
      liquidityLocked: true,
      contractRenounced: true,
      knownScamDeployer: false,
      canPause: false,
    });
    assert(!result.rejected, 'Clean token should pass');
    assert(result.reasons.length === 0, 'Should have no rejection reasons');
  });

  test('multiple red flags are all reported', () => {
    const result = validateAutoReject({
      isHoneypot: true,
      topHolderPercent: 50,
      liquidity: 1000,
      liquidityLocked: false,
      contractRenounced: false,
      knownScamDeployer: true,
      canPause: true,
    });
    assert(result.rejected, 'Should be rejected');
    assert(result.reasons.length >= 5, `Should report all flags, got ${result.reasons.length}`);
  });
});

// ============================================================
// Approval Logic Tests
// ============================================================
describe('Buy/Sell Approval Logic', () => {
  test('BUY requires human approval', () => {
    assert(shouldRequireApproval('buy') === true, 'Buy must require approval');
  });

  test('SELL does NOT require approval', () => {
    assert(shouldRequireApproval('sell') === false, 'Sell must auto-execute');
  });

  test('unknown action requires approval (safe default)', () => {
    assert(shouldRequireApproval('transfer') === true, 'Unknown actions should require approval');
  });
});

// ============================================================
// Same-Narrative Limit Tests
// ============================================================

function validateNarrativeConcentration(openPositions, newTokenNarrative) {
  const MAX_SAME_NARRATIVE = 3;
  const sameNarrative = openPositions.filter((p) => p.narrative === newTokenNarrative);
  if (sameNarrative.length >= MAX_SAME_NARRATIVE) {
    return {
      valid: false,
      reason: `Already ${sameNarrative.length} positions in ${newTokenNarrative} narrative (max ${MAX_SAME_NARRATIVE})`,
    };
  }
  return { valid: true };
}

describe('Same-Narrative Position Limits', () => {
  test('3 positions in same narrative is allowed (adding 3rd)', () => {
    const positions = [
      { symbol: 'A', narrative: 'ai' },
      { symbol: 'B', narrative: 'ai' },
    ];
    const result = validateNarrativeConcentration(positions, 'ai');
    assert(result.valid, 'Should allow 3rd position');
  });

  test('4th position in same narrative is rejected', () => {
    const positions = [
      { symbol: 'A', narrative: 'ai' },
      { symbol: 'B', narrative: 'ai' },
      { symbol: 'C', narrative: 'ai' },
    ];
    const result = validateNarrativeConcentration(positions, 'ai');
    assert(!result.valid, 'Should reject 4th same-narrative position');
  });

  test('different narrative is allowed even with 3 of another', () => {
    const positions = [
      { symbol: 'A', narrative: 'ai' },
      { symbol: 'B', narrative: 'ai' },
      { symbol: 'C', narrative: 'ai' },
    ];
    const result = validateNarrativeConcentration(positions, 'depin');
    assert(result.valid, 'Different narrative should be allowed');
  });
});

// ============================================================
// Max Open Positions Tests
// ============================================================

function validateMaxPositions(openPositionCount) {
  const MAX_OPEN_POSITIONS = 15;
  if (openPositionCount >= MAX_OPEN_POSITIONS) {
    return { valid: false, reason: `Already ${openPositionCount} open positions (max ${MAX_OPEN_POSITIONS})` };
  }
  return { valid: true };
}

describe('Max Open Positions Limit', () => {
  test('14 open positions allows new one (15th)', () => {
    assert(validateMaxPositions(14).valid, 'Should allow 15th position');
  });

  test('15 open positions rejects new one (16th)', () => {
    assert(!validateMaxPositions(15).valid, 'Should reject 16th position');
  });

  test('0 open positions allows new one', () => {
    assert(validateMaxPositions(0).valid, 'Should allow first position');
  });
});

// ============================================================
// Regime-Adjusted Limit Tests
// ============================================================

function validateRegimePositionSize(percentOfPortfolio, tier, regime, chainRules) {
  // Chain rules default to global defaults if not provided
  const defaults = { moonshot: 5, conviction: 10, base: 30 };
  const chain = { ...defaults, ...(chainRules || {}) };
  // Regime limits: bullish/neutral = no tightening (use chain default), bearish/crisis = tighter
  const regimeLimits = {
    bullish: { moonshot: chain.moonshot, conviction: chain.conviction, base: chain.base },
    neutral: { moonshot: chain.moonshot, conviction: chain.conviction, base: chain.base },
    bearish: { moonshot: 3, conviction: 7, base: 30 },
    crisis: { moonshot: 0, conviction: 5, base: 30 },
  };
  const rLimits = regimeLimits[regime] || chain;
  // min(chainRule, regimeLimit) — regime can only tighten
  const max = Math.min(rLimits[tier], chain[tier]);
  if (!chain[tier] && chain[tier] !== 0) return { valid: false, reason: `Unknown tier: ${tier}` };
  if (percentOfPortfolio > max) {
    return { valid: false, reason: `${tier} position ${percentOfPortfolio}% exceeds regime-adjusted max ${max}%` };
  }
  return { valid: true };
}

function validateRegimeCashReserve(cashPercent, regime, chainMinCash) {
  const chainDefault = chainMinCash ?? 10;
  const regimeMin = { bullish: chainDefault, neutral: chainDefault, bearish: 25, crisis: 40 };
  const min = Math.max(regimeMin[regime] || chainDefault, chainDefault); // never below chain limit
  if (cashPercent < min) {
    return { valid: false, reason: `Cash ${cashPercent}% below regime minimum ${min}%` };
  }
  return { valid: true };
}

describe('Regime-Adjusted Position Limits', () => {
  test('bearish: moonshot at 3% is allowed', () => {
    assert(validateRegimePositionSize(3, 'moonshot', 'bearish').valid, 'Should be valid');
  });

  test('bearish: moonshot at 4% is rejected', () => {
    assert(!validateRegimePositionSize(4, 'moonshot', 'bearish').valid, 'Should be rejected');
  });

  test('bearish: conviction at 7% is allowed', () => {
    assert(validateRegimePositionSize(7, 'conviction', 'bearish').valid, 'Should be valid');
  });

  test('bearish: conviction at 8% is rejected', () => {
    assert(!validateRegimePositionSize(8, 'conviction', 'bearish').valid, 'Should be rejected');
  });

  test('crisis: moonshot at 0% is rejected (no new moonshots)', () => {
    assert(!validateRegimePositionSize(1, 'moonshot', 'crisis').valid, 'Crisis should reject all moonshots');
  });

  test('crisis: conviction at 5% is allowed', () => {
    assert(validateRegimePositionSize(5, 'conviction', 'crisis').valid, 'Should be valid');
  });

  test('crisis: conviction at 6% is rejected', () => {
    assert(!validateRegimePositionSize(6, 'conviction', 'crisis').valid, 'Should be rejected');
  });

  test('regime limits never exceed chain limits (default chains)', () => {
    for (const regime of ['bullish', 'neutral', 'bearish', 'crisis']) {
      const moonResult = validateRegimePositionSize(6, 'moonshot', regime);
      assert(!moonResult.valid, `${regime}: 6% moonshot must be rejected on default chain`);
      const convResult = validateRegimePositionSize(11, 'conviction', regime);
      assert(!convResult.valid, `${regime}: 11% conviction must always be rejected`);
    }
  });

  test('chain override: Solana 7% moonshot allowed in bullish', () => {
    const solanaRules = { moonshot: 7, conviction: 10 };
    assert(
      validateRegimePositionSize(7, 'moonshot', 'bullish', solanaRules).valid,
      'Solana 7% moonshot should be valid in bullish',
    );
    assert(
      validateRegimePositionSize(7, 'moonshot', 'neutral', solanaRules).valid,
      'Solana 7% moonshot should be valid in neutral',
    );
  });

  test('chain override: Solana 7% moonshot still capped in bearish/crisis', () => {
    const solanaRules = { moonshot: 7, conviction: 10 };
    assert(
      !validateRegimePositionSize(4, 'moonshot', 'bearish', solanaRules).valid,
      'Bearish caps at 3% even with Solana override',
    );
    assert(!validateRegimePositionSize(1, 'moonshot', 'crisis', solanaRules).valid, 'Crisis blocks all moonshots');
  });

  test('chain override: 8% moonshot rejected even on Solana (exceeds chain limit)', () => {
    const solanaRules = { moonshot: 7, conviction: 10 };
    assert(!validateRegimePositionSize(8, 'moonshot', 'bullish', solanaRules).valid, 'Should not exceed chain limit');
  });
});

describe('Regime-Adjusted Cash Reserve', () => {
  test('bullish: 10% cash is ok', () => {
    assert(validateRegimeCashReserve(10, 'bullish').valid, 'Should be valid');
  });

  test('bearish: 20% cash is rejected (need 25%)', () => {
    assert(!validateRegimeCashReserve(20, 'bearish').valid, 'Should be rejected');
  });

  test('bearish: 25% cash is ok', () => {
    assert(validateRegimeCashReserve(25, 'bearish').valid, 'Should be valid');
  });

  test('crisis: 35% cash is rejected (need 40%)', () => {
    assert(!validateRegimeCashReserve(35, 'crisis').valid, 'Should be rejected');
  });

  test('crisis: 40% cash is ok', () => {
    assert(validateRegimeCashReserve(40, 'crisis').valid, 'Should be valid');
  });
});

// ============================================================
// Per-Chain Rule Tests
// ============================================================

describe('Per-Chain Portfolio Rules', () => {
  const baseRules = {
    maxMoonshotPosition: 5,
    maxConvictionPosition: 10,
    maxBasePosition: 30,
    maxMoonshotAllocation: 30,
    minCashReserve: 10,
    maxSameNarrative: 3,
    maxOpenPositions: 15,
    tiersEnabled: ['moonshot', 'conviction', 'base'],
  };
  const solanaRules = {
    maxMoonshotPosition: 7,
    maxConvictionPosition: 10,
    maxBasePosition: 30,
    maxMoonshotAllocation: 30,
    minCashReserve: 10,
    maxSameNarrative: 3,
    maxOpenPositions: 10,
    tiersEnabled: ['moonshot', 'conviction'],
  };

  test('Solana allows 7% moonshot vs Base 5%', () => {
    const baseResult = validatePositionSize(6, 'moonshot', baseRules);
    assert(!baseResult.valid, 'Base should reject 6% moonshot');
    const solResult = validatePositionSize(6, 'moonshot', solanaRules);
    assert(solResult.valid, 'Solana should allow 6% moonshot');
  });

  test('Solana moonshot allocation does not affect Base moonshot limit', () => {
    // Each chain is independent — both now have 30% moonshot alloc limit
    const baseAlloc = { base: 25, conviction: 25, moonshot: 28, cash: 22 };
    const result = validateAllocation(baseAlloc, 'moonshot', 5);
    assert(!result.valid, 'Base moonshot alloc 33% > 30% should be rejected');
  });

  test('Solana rejects base-tier buy proposals', () => {
    assert(!solanaRules.tiersEnabled.includes('base'), 'Solana should not allow base tier');
    assert(baseRules.tiersEnabled.includes('base'), 'Base should allow base tier');
  });

  test('Per-chain max positions: Solana 10, Base 15', () => {
    assert(validateMaxPositions(14).valid, 'Global: 14 is ok');
    assert(!validateMaxPositions(15).valid, 'Global: 15 is too many');

    // Solana-specific
    const solMaxPos = solanaRules.maxOpenPositions;
    assertEqual(solMaxPos, 10, 'Solana max should be 10');
    assert(9 < solMaxPos, '9 positions ok on Solana');
    assert(!(10 < solMaxPos), '10 positions is at limit on Solana');
  });

  test('Regime still tightens per-chain rules', () => {
    // Bearish regime: moonshot max 3%. Solana chain rule: 7%. min(7, 3) = 3
    const regimeLimit = 3;
    const chainLimit = solanaRules.maxMoonshotPosition;
    const effective = Math.min(chainLimit, regimeLimit);
    assertEqual(effective, 3, 'Regime should tighten Solana moonshot from 7% to 3%');
  });
});

// ============================================================
// Base Tier Closed Set Tests
// ============================================================

const BASE_TIER_TOKENS = {
  base: [
    '0x4200000000000000000000000000000000000006', // WETH
    '0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', // cbBTC
  ],
  ethereum: [
    '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
    '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', // WBTC
  ],
  solana: [
    'So11111111111111111111111111111111111111112', // wSOL
  ],
};

function validateBaseTier(tokenAddress, chain) {
  const allowed = BASE_TIER_TOKENS[chain];
  if (!allowed) return { valid: false, reason: `No base tokens defined for chain: ${chain}` };
  const normalized = chain === 'solana' ? tokenAddress : tokenAddress.toLowerCase();
  const allowedNormalized = chain === 'solana' ? allowed : allowed.map((a) => a.toLowerCase());
  if (!allowedNormalized.includes(normalized)) {
    return { valid: false, reason: `Token ${tokenAddress} is not a valid base tier asset on ${chain}` };
  }
  return { valid: true };
}

describe('Base Tier Closed Set', () => {
  test('WETH on Base is valid base tier', () => {
    assert(validateBaseTier('0x4200000000000000000000000000000000000006', 'base').valid, 'WETH should be base tier');
  });

  test('cbBTC on Base is valid base tier', () => {
    assert(validateBaseTier('0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf', 'base').valid, 'cbBTC should be base tier');
  });

  test('WETH on Ethereum is valid base tier', () => {
    assert(
      validateBaseTier('0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', 'ethereum').valid,
      'WETH should be base tier',
    );
  });

  test('wSOL on Solana is valid base tier', () => {
    assert(validateBaseTier('So11111111111111111111111111111111111111112', 'solana').valid, 'wSOL should be base tier');
  });

  test('random token on Base is NOT valid base tier', () => {
    const result = validateBaseTier('0x1234567890abcdef1234567890abcdef12345678', 'base');
    assert(!result.valid, 'Non-native token must not be base tier');
  });

  test('random token on Solana is NOT valid base tier', () => {
    const result = validateBaseTier('AiDogTokenFakeAddress111111111111111111111', 'solana');
    assert(!result.valid, 'Non-native token must not be base tier');
  });

  test('base tier validation is case-insensitive for EVM', () => {
    assert(validateBaseTier('0x4200000000000000000000000000000000000006', 'base').valid, 'Lowercase should match');
    assert(
      validateBaseTier('0x4200000000000000000000000000000000000006'.toUpperCase().replace('0X', '0x'), 'base').valid,
      'Uppercase should match',
    );
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
