/**
 * Unit tests for paper-executor.ts
 */
import { describe, it, expect } from 'vitest';
import { PaperExecutor } from './paper-executor.js';
import type { OrderResponseDto } from './dto/order-response.dto.js';

const BASE_ORDER: OrderResponseDto = {
  id: 'order-001',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0001',
  chain: 'base',
  amount: '500',
  status: 'approved',
  entry_price: 2000,
  tier: 'conviction',
};

describe('PaperExecutor.simulate()', () => {
  const executor = new PaperExecutor();

  it('returns a paper receipt with mode=paper', () => {
    const receipt = executor.simulate(BASE_ORDER);
    expect(receipt.mode).toBe('paper');
  });

  it('maps order_id from order.id', () => {
    const receipt = executor.simulate(BASE_ORDER);
    expect(receipt.order_id).toBe('order-001');
  });

  it('sets expected_price and executed_price to entry_price', () => {
    const receipt = executor.simulate(BASE_ORDER);
    expect(receipt.expected_price).toBe(2000);
    expect(receipt.executed_price).toBe(2000);
  });

  it('calculates quantity from amount / entry_price', () => {
    const receipt = executor.simulate(BASE_ORDER);
    // 500 USD / 2000 USD/ETH = 0.25 ETH
    expect(receipt.quantity).toBeCloseTo(0.25, 5);
  });

  it('sets slippage to 0 (no slippage simulation in P1c-i)', () => {
    const receipt = executor.simulate(BASE_ORDER);
    expect(receipt.slippage).toBe(0);
  });

  it('handles missing entry_price gracefully (price=0)', () => {
    const order = { ...BASE_ORDER, entry_price: undefined };
    const receipt = executor.simulate(order);
    expect(receipt.expected_price).toBe(0);
    expect(receipt.quantity).toBe(0);
  });

  it('includes paper_mode:simulated note', () => {
    const receipt = executor.simulate(BASE_ORDER);
    expect(receipt.notes).toBe('paper_mode:simulated');
  });
});
