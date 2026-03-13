#!/usr/bin/env node
/**
 * Test Suite: Executor Agent
 *
 * Tests the Executor's validation logic, receipt generation,
 * portfolio state updates, and order processing rules.
 */

import { describe, test, assert, assertEqual, assertType, summary } from './test-helpers.js';

// ============================================================
// Executor Validation Logic (extracted from AGENTS.md)
// ============================================================

function validateBuyOrder(order, portfolioState) {
  const errors = [];

  if (!order.approved) {
    errors.push('Order not approved by human');
  }

  const tierLimits = { moonshot: 5, conviction: 10, base: 50 };
  const maxPercent = tierLimits[order.tier];
  if (!maxPercent) {
    errors.push(`Unknown tier: ${order.tier}`);
  } else if (order.percentOfPortfolio > maxPercent) {
    errors.push(`Position ${order.percentOfPortfolio}% exceeds ${order.tier} limit of ${maxPercent}%`);
  }

  if (order.amount > portfolioState.cash) {
    errors.push(`Insufficient cash: need $${order.amount}, have $${portfolioState.cash}`);
  }

  if (order.currentPrice && order.entryPrice) {
    const deviation = Math.abs(order.currentPrice - order.entryPrice) / order.entryPrice;
    if (deviation > 0.10) {
      errors.push(`Price deviated ${(deviation * 100).toFixed(1)}% from proposal (max 10%)`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function validateSellOrder(order, portfolioState) {
  const errors = [];

  const position = portfolioState.positions.find(p =>
    p.address === order.address && p.chain === order.chain
  );

  if (!position) {
    errors.push(`No position found for ${order.symbol} on ${order.chain}`);
    return { valid: false, errors };
  }

  if (position.address !== order.address) {
    errors.push('Token address mismatch');
  }

  if (order.amount !== 'all') {
    const percent = parseInt(order.amount);
    if (isNaN(percent) || percent <= 0 || percent > 100) {
      errors.push(`Invalid sell amount: ${order.amount}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function buildReceipt(order, source, status, details = {}) {
  return {
    id: `receipt-${Date.now()}`,
    orderId: order.id,
    orderSource: source,
    timestamp: new Date().toISOString(),
    action: order.action,
    symbol: order.symbol,
    address: order.address,
    chain: order.chain,
    amount: order.amount,
    status: status,
    safeTxHash: details.safeTxHash || null,
    onchainTxHash: details.onchainTxHash || null,
    executedPrice: details.executedPrice || null,
    slippage: details.slippage || null,
    error: details.error || null,
  };
}

function checkSlippage(expectedPrice, quotedPrice, tier) {
  const maxSlippage = tier === 'moonshot' ? 0.05 : 0.02;
  const slippage = Math.abs(quotedPrice - expectedPrice) / expectedPrice;
  return {
    acceptable: slippage <= maxSlippage,
    slippage,
    maxSlippage,
  };
}

function processOrderPriority(sellOrders, buyOrders) {
  // Sells always processed first
  return [...sellOrders.map(o => ({ ...o, _priority: 'sell' })),
          ...buyOrders.map(o => ({ ...o, _priority: 'buy' }))];
}

// ============================================================
// Mock Data
// ============================================================

const mockPortfolio = {
  cash: 5000,
  totalDeposited: 10000,
  positions: [
    {
      id: 'pos-001',
      symbol: 'MOCK',
      address: '0xmock123',
      chain: 'base',
      tier: 'moonshot',
      entryPrice: 0.001,
      currentPrice: 0.0015,
      quantity: 100000,
      stopLoss: 0.0005,
      takeProfitLevels: [
        { level: 1, multiplier: 2, price: 0.002, sellPercent: 50, triggered: false },
      ],
      status: 'open',
    },
  ],
};

const mockApprovedBuy = {
  id: 'trade-001',
  action: 'buy',
  symbol: 'NEWTOKEN',
  address: '0xnew456',
  chain: 'ethereum',
  amount: 400,
  percentOfPortfolio: 4,
  tier: 'moonshot',
  entryPrice: 0.05,
  currentPrice: 0.052,
  approved: true,
  executed: false,
};

const mockSellOrder = {
  id: 'sell-001',
  action: 'sell',
  symbol: 'MOCK',
  address: '0xmock123',
  chain: 'base',
  amount: 'all',
  reason: 'stop_loss',
  urgency: 'immediate',
  executed: false,
};

// ============================================================
// Buy Validation Tests
// ============================================================
describe('Executor — Buy Order Validation', () => {
  test('approved buy within limits passes', () => {
    const result = validateBuyOrder(mockApprovedBuy, mockPortfolio);
    assert(result.valid, `Should pass: ${result.errors.join(', ')}`);
  });

  test('unapproved buy is rejected', () => {
    const order = { ...mockApprovedBuy, approved: false };
    const result = validateBuyOrder(order, mockPortfolio);
    assert(!result.valid, 'Unapproved buy must be rejected');
    assert(result.errors.some(e => e.includes('not approved')), 'Should mention approval');
  });

  test('buy exceeding tier limit is rejected', () => {
    const order = { ...mockApprovedBuy, percentOfPortfolio: 6 };
    const result = validateBuyOrder(order, mockPortfolio);
    assert(!result.valid, 'Over-limit buy must be rejected');
  });

  test('buy exceeding cash balance is rejected', () => {
    const order = { ...mockApprovedBuy, amount: 6000 };
    const result = validateBuyOrder(order, mockPortfolio);
    assert(!result.valid, 'Insufficient cash must be rejected');
    assert(result.errors.some(e => e.includes('Insufficient cash')), 'Should mention cash');
  });

  test('buy with stale price (>10% deviation) is rejected', () => {
    const order = { ...mockApprovedBuy, currentPrice: 0.06 }; // 20% above entry
    const result = validateBuyOrder(order, mockPortfolio);
    assert(!result.valid, 'Stale price must be rejected');
    assert(result.errors.some(e => e.includes('deviated')), 'Should mention price deviation');
  });

  test('buy with price within 10% passes', () => {
    const order = { ...mockApprovedBuy, currentPrice: 0.054 }; // 8% above
    const result = validateBuyOrder(order, mockPortfolio);
    assert(result.valid, 'Price within 10% should pass');
  });
});

// ============================================================
// Sell Validation Tests
// ============================================================
describe('Executor — Sell Order Validation', () => {
  test('sell order for existing position passes', () => {
    const result = validateSellOrder(mockSellOrder, mockPortfolio);
    assert(result.valid, `Should pass: ${result.errors.join(', ')}`);
  });

  test('sell order for non-existent position is rejected', () => {
    const order = { ...mockSellOrder, address: '0xnonexistent' };
    const result = validateSellOrder(order, mockPortfolio);
    assert(!result.valid, 'Non-existent position must be rejected');
    assert(result.errors.some(e => e.includes('No position found')), 'Should mention missing position');
  });

  test('sell order with wrong chain is rejected', () => {
    const order = { ...mockSellOrder, chain: 'ethereum' };
    const result = validateSellOrder(order, mockPortfolio);
    assert(!result.valid, 'Wrong chain must be rejected');
  });

  test('partial sell with valid percentage passes', () => {
    const order = { ...mockSellOrder, amount: '50%' };
    const result = validateSellOrder(order, mockPortfolio);
    assert(result.valid, 'Valid partial sell should pass');
  });

  test('sell-all passes', () => {
    const order = { ...mockSellOrder, amount: 'all' };
    const result = validateSellOrder(order, mockPortfolio);
    assert(result.valid, 'Sell-all should pass');
  });
});

// ============================================================
// Slippage Tests
// ============================================================
describe('Executor — Slippage Protection', () => {
  test('moonshot allows up to 5% slippage', () => {
    const result = checkSlippage(0.001, 0.00104, 'moonshot');
    assert(result.acceptable, '4% slippage on moonshot should be ok');
  });

  test('moonshot rejects >5% slippage', () => {
    const result = checkSlippage(0.001, 0.00106, 'moonshot');
    assert(!result.acceptable, '6% slippage on moonshot should be rejected');
  });

  test('conviction allows up to 2% slippage', () => {
    const result = checkSlippage(1.0, 1.019, 'conviction');
    assert(result.acceptable, '1.9% slippage on conviction should be ok');
  });

  test('conviction rejects >2% slippage', () => {
    const result = checkSlippage(1.0, 1.025, 'conviction');
    assert(!result.acceptable, '2.5% slippage on conviction should be rejected');
  });

  test('base uses same limit as conviction (2%)', () => {
    const result = checkSlippage(10.0, 10.3, 'base');
    assert(!result.acceptable, '3% slippage on base should be rejected');
  });
});

// ============================================================
// Receipt Generation Tests
// ============================================================
describe('Executor — Receipt Generation', () => {
  test('receipt has all required fields', () => {
    const receipt = buildReceipt(mockSellOrder, 'sell-orders', 'executed', {
      safeTxHash: '0xsafe123',
      onchainTxHash: '0xchain456',
      executedPrice: 0.0014,
      slippage: 0.01,
    });

    assert(receipt.id, 'Must have id');
    assertEqual(receipt.orderId, 'sell-001', 'Must reference source order');
    assertEqual(receipt.orderSource, 'sell-orders', 'Must identify source');
    assertEqual(receipt.status, 'executed', 'Must have status');
    assertEqual(receipt.safeTxHash, '0xsafe123', 'Must have Safe tx hash');
    assertEqual(receipt.onchainTxHash, '0xchain456', 'Must have on-chain tx hash');
    assert(receipt.timestamp, 'Must have timestamp');
  });

  test('failed receipt includes error', () => {
    const receipt = buildReceipt(mockApprovedBuy, 'approved-trades', 'validation_failed', {
      error: 'Order not approved',
    });

    assertEqual(receipt.status, 'validation_failed', 'Status should be validation_failed');
    assertEqual(receipt.error, 'Order not approved', 'Must include error message');
    assertEqual(receipt.safeTxHash, null, 'Failed tx should have no hash');
  });

  test('queued receipt has Safe hash but no on-chain hash', () => {
    const receipt = buildReceipt(mockApprovedBuy, 'approved-trades', 'queued_in_safe', {
      safeTxHash: '0xsafe789',
    });

    assertEqual(receipt.status, 'queued_in_safe', 'Status should be queued');
    assertEqual(receipt.safeTxHash, '0xsafe789', 'Must have Safe tx hash');
    assertEqual(receipt.onchainTxHash, null, 'Should not have on-chain hash yet');
  });
});

// ============================================================
// Order Priority Tests
// ============================================================
describe('Executor — Order Priority', () => {
  test('sell orders come before buy orders', () => {
    const sells = [{ id: 's1', action: 'sell' }, { id: 's2', action: 'sell' }];
    const buys = [{ id: 'b1', action: 'buy' }];
    const ordered = processOrderPriority(sells, buys);

    assertEqual(ordered[0]._priority, 'sell', 'First should be sell');
    assertEqual(ordered[1]._priority, 'sell', 'Second should be sell');
    assertEqual(ordered[2]._priority, 'buy', 'Last should be buy');
  });

  test('empty sells still processes buys', () => {
    const ordered = processOrderPriority([], [{ id: 'b1', action: 'buy' }]);
    assertEqual(ordered.length, 1, 'Should have 1 order');
    assertEqual(ordered[0]._priority, 'buy', 'Should be buy');
  });

  test('empty buys still processes sells', () => {
    const ordered = processOrderPriority([{ id: 's1', action: 'sell' }], []);
    assertEqual(ordered.length, 1, 'Should have 1 order');
    assertEqual(ordered[0]._priority, 'sell', 'Should be sell');
  });
});

// ============================================================
// Portfolio State Update Tests
// ============================================================
describe('Executor — Portfolio State Updates', () => {
  test('buy adds position and reduces cash', () => {
    const state = JSON.parse(JSON.stringify(mockPortfolio));
    const before = state.cash;
    const amount = 400;

    // Simulate buy execution
    state.positions.push({
      id: 'pos-new',
      symbol: 'NEWTOKEN',
      address: '0xnew456',
      chain: 'ethereum',
      tier: 'moonshot',
      entryPrice: 0.05,
      currentPrice: 0.05,
      quantity: 8000,
      status: 'open',
    });
    state.cash -= amount;

    assertEqual(state.positions.length, 2, 'Should have 2 positions');
    assertEqual(state.cash, before - amount, 'Cash should be reduced');
  });

  test('sell-all removes position and adds to cash', () => {
    const state = JSON.parse(JSON.stringify(mockPortfolio));
    const position = state.positions[0];
    const proceeds = position.quantity * position.currentPrice;

    state.cash += proceeds;
    state.positions = state.positions.filter(p => p.id !== position.id);

    assertEqual(state.positions.length, 0, 'Position should be removed');
    assert(state.cash > mockPortfolio.cash, 'Cash should increase');
  });

  test('partial sell reduces quantity and adds to cash', () => {
    const state = JSON.parse(JSON.stringify(mockPortfolio));
    const position = state.positions[0];
    const sellPercent = 50;
    const sellQuantity = position.quantity * (sellPercent / 100);
    const proceeds = sellQuantity * position.currentPrice;

    position.quantity -= sellQuantity;
    state.cash += proceeds;

    assertEqual(position.quantity, 50000, 'Quantity should be halved');
    assert(state.cash > mockPortfolio.cash, 'Cash should increase');
    assertEqual(state.positions.length, 1, 'Position should still exist');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
