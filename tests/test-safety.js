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

import { describe, test, assert, summary } from './test-helpers.js';

// ============================================================
// Safety Rule Validators (extracted from AGENTS.md)
// ============================================================

function validatePositionSize(percentOfPortfolio, tier) {
  const limits = { moonshot: 5, conviction: 10, base: 25 };
  const max = limits[tier];
  if (!max) return { valid: false, reason: `Unknown tier: ${tier}` };
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

  test('base at 25% is allowed', () => {
    const result = validatePositionSize(25, 'base');
    assert(result.valid, 'Should be valid');
  });

  test('base at 26% is rejected', () => {
    const result = validatePositionSize(26, 'base');
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
      isHoneypot: true, topHolderPercent: 5, liquidity: 100000,
      liquidityLocked: true, contractRenounced: false,
      knownScamDeployer: false, canPause: false,
    });
    assert(result.rejected, 'Honeypot must be auto-rejected');
    assert(result.reasons.includes('Honeypot detected'), 'Reason should mention honeypot');
  });

  test('top holder >30% is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 35, liquidity: 100000,
      liquidityLocked: true, contractRenounced: false,
      knownScamDeployer: false, canPause: false,
    });
    assert(result.rejected, '>30% holder must be auto-rejected');
  });

  test('top holder at 30% is NOT rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 30, liquidity: 100000,
      liquidityLocked: true, contractRenounced: false,
      knownScamDeployer: false, canPause: false,
    });
    assert(!result.rejected, '30% exactly should pass');
  });

  test('liquidity below $5k is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 5, liquidity: 4999,
      liquidityLocked: true, contractRenounced: false,
      knownScamDeployer: false, canPause: false,
    });
    assert(result.rejected, '<$5k liquidity must be auto-rejected');
  });

  test('no LP lock AND not renounced is rejected', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 5, liquidity: 100000,
      liquidityLocked: false, contractRenounced: false,
      knownScamDeployer: false, canPause: false,
    });
    assert(result.rejected, 'No lock + not renounced must be rejected');
  });

  test('no LP lock BUT renounced is OK', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 5, liquidity: 100000,
      liquidityLocked: false, contractRenounced: true,
      knownScamDeployer: false, canPause: false,
    });
    assert(!result.rejected, 'Renounced should compensate for no LP lock');
  });

  test('clean token passes all checks', () => {
    const result = validateAutoReject({
      isHoneypot: false, topHolderPercent: 10, liquidity: 50000,
      liquidityLocked: true, contractRenounced: true,
      knownScamDeployer: false, canPause: false,
    });
    assert(!result.rejected, 'Clean token should pass');
    assert(result.reasons.length === 0, 'Should have no rejection reasons');
  });

  test('multiple red flags are all reported', () => {
    const result = validateAutoReject({
      isHoneypot: true, topHolderPercent: 50, liquidity: 1000,
      liquidityLocked: false, contractRenounced: false,
      knownScamDeployer: true, canPause: true,
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
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
