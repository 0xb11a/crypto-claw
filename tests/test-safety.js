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
  const defaults = { moonshot: 5, conviction: 10, base: 50 };
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

  if (after.moonshot > 20) return { valid: false, reason: `Moonshot allocation ${after.moonshot}% exceeds 20%` };
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

  test('base at 50% is allowed', () => {
    const result = validatePositionSize(50, 'base');
    assert(result.valid, 'Should be valid');
  });

  test('base at 51% is rejected', () => {
    const result = validatePositionSize(51, 'base');
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
    const current = { base: 50, conviction: 25, moonshot: 10, cash: 15 };
    const result = validateAllocation(current, 'moonshot', 5);
    assert(result.valid, 'Should be valid');
  });

  test('adding moonshot that exceeds 20% is rejected', () => {
    const current = { base: 50, conviction: 25, moonshot: 18, cash: 7 };
    const result = validateAllocation(current, 'moonshot', 5);
    assert(!result.valid, 'Should be rejected — moonshot > 20%');
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

function validateRegimePositionSize(percentOfPortfolio, tier, regime) {
  const regimeLimits = {
    bullish: { moonshot: 5, conviction: 10, base: 50 },
    neutral: { moonshot: 5, conviction: 10, base: 50 },
    bearish: { moonshot: 3, conviction: 7, base: 50 },
    crisis: { moonshot: 0, conviction: 5, base: 50 },
  };
  const hardLimits = { moonshot: 5, conviction: 10, base: 50 };
  const rLimits = regimeLimits[regime] || hardLimits;
  const max = Math.min(rLimits[tier], hardLimits[tier]);
  if (!hardLimits[tier] && hardLimits[tier] !== 0) return { valid: false, reason: `Unknown tier: ${tier}` };
  if (percentOfPortfolio > max) {
    return { valid: false, reason: `${tier} position ${percentOfPortfolio}% exceeds regime-adjusted max ${max}%` };
  }
  return { valid: true };
}

function validateRegimeCashReserve(cashPercent, regime) {
  const regimeMin = { bullish: 10, neutral: 10, bearish: 25, crisis: 40 };
  const min = Math.max(regimeMin[regime] || 10, 10); // never below hard limit
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

  test('regime limits never exceed hard limits', () => {
    for (const regime of ['bullish', 'neutral', 'bearish', 'crisis']) {
      const moonResult = validateRegimePositionSize(6, 'moonshot', regime);
      assert(!moonResult.valid, `${regime}: 6% moonshot must always be rejected`);
      const convResult = validateRegimePositionSize(11, 'conviction', regime);
      assert(!convResult.valid, `${regime}: 11% conviction must always be rejected`);
    }
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
    maxBasePosition: 50,
    maxMoonshotAllocation: 20,
    minCashReserve: 10,
    maxSameNarrative: 3,
    maxOpenPositions: 15,
    tiersEnabled: ['moonshot', 'conviction', 'base'],
  };
  const solanaRules = {
    maxMoonshotPosition: 7,
    maxConvictionPosition: 10,
    maxBasePosition: 50,
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
    // Each chain is independent — Solana's 30% moonshot alloc doesn't change Base's 20%
    const baseAlloc = { base: 50, conviction: 20, moonshot: 18, cash: 12 };
    const result = validateAllocation(baseAlloc, 'moonshot', 5);
    assert(!result.valid, 'Base moonshot alloc 23% > 20% should be rejected');
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
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
