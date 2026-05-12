/**
 * Unit tests for apps/executor/src/execute-trade-stub.ts
 */
import { describe, it, expect } from 'vitest';
import { executeTrade } from './execute-trade-stub.js';
import type { OrderInput } from '@cclaw/execution';

const BASE_ORDER: OrderInput = {
  id: 'test-order-abc123',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '500.00',
  expected_amount_out: 0.25,
  slippage_bps: 50,
  tier: 'conviction',
};

describe('executeTrade() — stub mode', () => {
  it('throws not_yet_implemented_real_mode when EXECUTOR_STUB_MODE is not 1', async () => {
    await expect(executeTrade(BASE_ORDER, {})).rejects.toThrow('not_yet_implemented_real_mode');
  });

  it('returns a success receipt when EXECUTOR_STUB_MODE=1', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(receipt.status).toBe('executed');
  });

  it('receipt tx_hash starts with 0x and is 66 chars', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(receipt.tx_hash).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('receipt tx_hash is deterministic for same order id', async () => {
    const r1 = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    const r2 = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(r1.tx_hash).toBe(r2.tx_hash);
  });

  it('receipt tx_hash differs for different order ids', async () => {
    const order2 = { ...BASE_ORDER, id: 'different-order-id-xyz' };
    const r1 = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    const r2 = await executeTrade(order2, { EXECUTOR_STUB_MODE: '1' });
    expect(r1.tx_hash).not.toBe(r2.tx_hash);
  });

  it('receipt actual_amount_in matches order amount', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(receipt.actual_amount_in).toBe(BASE_ORDER.amount);
  });

  it('receipt actual_amount_out matches expected_amount_out', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(receipt.actual_amount_out).toBe(BASE_ORDER.expected_amount_out);
  });

  it('receipt block_number is 1000000 (deterministic stub)', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(receipt.block_number).toBe(1_000_000);
  });

  it('receipt executed_at is a valid ISO datetime', async () => {
    const receipt = await executeTrade(BASE_ORDER, { EXECUTOR_STUB_MODE: '1' });
    expect(() => new Date(receipt.executed_at).toISOString()).not.toThrow();
  });
});
