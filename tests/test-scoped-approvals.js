#!/usr/bin/env node
/**
 * Test Suite: Scoped ERC-20 Approvals (PR 2.5)
 *
 * Defangs the "1inch router compromise" worst case. Previously the
 * executor approved maxUint256 (~unlimited) USDC + token allowance
 * to the 1inch router. If 1inch's contracts were ever exploited (or
 * a malicious upgrade slipped through), the attacker could drain the
 * full Safe balance via the standing approval.
 *
 * PR 2.5 scopes each approval to `quote_amount * (1 + margin)`, so
 * even a worst-case router compromise can only take the in-flight
 * trade amount plus the margin. Trade-off: ~$3 extra gas per buy
 * because each swap now needs a fresh approval.
 */

import { describe, test, assertEqual, assert, summary } from './test-helpers.js';
import { computeApprovalAmount } from '../scripts/execute-trade-evm.js';

describe('computeApprovalAmount() — default 5% margin', () => {
  test('100 USDC (1e8 wei at 6 decimals) → 105 USDC approval', () => {
    const amountWei = 100_000_000n; // $100 USDC
    const out = computeApprovalAmount(amountWei, 5);
    assertEqual(out, 105_000_000n);
  });

  test('1000 USDC → 1050 USDC approval', () => {
    const out = computeApprovalAmount(1_000_000_000n, 5);
    assertEqual(out, 1_050_000_000n);
  });

  test('1 USDC (smallest realistic trade) → 1.05 USDC approval', () => {
    const out = computeApprovalAmount(1_000_000n, 5);
    assertEqual(out, 1_050_000n);
  });

  test('zero amount returns zero', () => {
    assertEqual(computeApprovalAmount(0n, 5), 0n);
  });
});

describe('computeApprovalAmount() — configurable margin', () => {
  test('10% margin', () => {
    assertEqual(computeApprovalAmount(100_000_000n, 10), 110_000_000n);
  });

  test('0% margin (exact amount, no buffer)', () => {
    assertEqual(computeApprovalAmount(100_000_000n, 0), 100_000_000n);
  });

  test('100% margin (double)', () => {
    assertEqual(computeApprovalAmount(100_000_000n, 100), 200_000_000n);
  });

  test('huge amount preserves precision (no float overflow)', () => {
    // 1 billion USDC at 6 decimals = 1e15 wei — way past Number safe range.
    // BigInt math should handle this exactly.
    const huge = 1_000_000_000_000_000n;
    const out = computeApprovalAmount(huge, 5);
    assertEqual(out, 1_050_000_000_000_000n);
  });

  test('18-decimal token (e.g. WETH) — 1 ETH input → 1.05 ETH approval', () => {
    const oneEth = 1_000_000_000_000_000_000n;
    const out = computeApprovalAmount(oneEth, 5);
    assertEqual(out, 1_050_000_000_000_000_000n);
  });
});

describe('computeApprovalAmount() — defensive', () => {
  test('throws on non-bigint amount', () => {
    let caught = null;
    try {
      computeApprovalAmount(100, 5);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof TypeError, 'should throw TypeError');
  });

  test('throws on string amount', () => {
    let caught = null;
    try {
      computeApprovalAmount('100', 5);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof TypeError);
  });

  test('throws on negative amount', () => {
    let caught = null;
    try {
      computeApprovalAmount(-100n, 5);
    } catch (e) {
      caught = e;
    }
    assert(caught instanceof RangeError);
  });

  test('non-numeric margin defaults to 5%', () => {
    // Caller might pass NaN from a misconfigured env var.
    const out = computeApprovalAmount(100_000_000n, NaN);
    assertEqual(out, 105_000_000n);
  });

  test('negative margin defaults to 5%', () => {
    const out = computeApprovalAmount(100_000_000n, -10);
    assertEqual(out, 105_000_000n);
  });

  test('non-integer margin (e.g. 5.5) is floored to 5', () => {
    // We use integer math; fractional percentages are rounded down
    // for predictable BigInt behavior.
    const out = computeApprovalAmount(100_000_000n, 5.9);
    assertEqual(out, 105_000_000n);
  });
});

describe('PR 2.5 invariant — approval cap dramatically smaller than maxUint256', () => {
  test('legacy maxUint256 = 2^256-1; scoped is many orders smaller', () => {
    const MAX_UINT256 = (1n << 256n) - 1n;
    const scoped = computeApprovalAmount(1_000_000_000n, 5); // $1k USDC
    // The blast-radius reduction we care about: scoped is at least
    // 10^60 times smaller than the worst case. (USDC max supply is
    // ~10^16 wei, so even "$10B" ≪ uint256.)
    assert(scoped < MAX_UINT256 / 10n ** 60n, 'scoped approval should be massively smaller');
  });
});

process.exit(summary() ? 0 : 1);
