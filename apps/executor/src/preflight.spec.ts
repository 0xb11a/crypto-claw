/**
 * Unit tests for apps/executor/src/preflight.ts
 */
import { describe, it, expect } from 'vitest';
import { assertSignerKeysPresent, checkSlippage } from './preflight.js';
import type { OrderInput } from '@cclaw/execution';

// Minimal valid order used as a base in tests
const BASE_ORDER: OrderInput = {
  id: 'test-order-001',
  action: 'buy',
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '100',
  entry_price: 2000,
  slippage_bps: 200,
  tier: 'conviction',
};

describe('assertSignerKeysPresent()', () => {
  it('passes for EVM chain when SAFE_SIGNER_KEY is set', () => {
    expect(() => assertSignerKeysPresent('base', { SAFE_SIGNER_KEY: 'test-key' })).not.toThrow();
  });

  it('throws for EVM chain when SAFE_SIGNER_KEY is missing', () => {
    expect(() => assertSignerKeysPresent('base', {})).toThrow('SAFE_SIGNER_KEY');
  });

  it('throws for EVM chain when SAFE_SIGNER_KEY is empty string', () => {
    expect(() => assertSignerKeysPresent('base', { SAFE_SIGNER_KEY: '' })).toThrow('SAFE_SIGNER_KEY');
  });

  it('passes for solana when SQUADS_SIGNER_KEY is set', () => {
    expect(() => assertSignerKeysPresent('solana', { SQUADS_SIGNER_KEY: 'test-squads-key' })).not.toThrow();
  });

  it('throws for solana when SQUADS_SIGNER_KEY is missing', () => {
    expect(() => assertSignerKeysPresent('solana', { SAFE_SIGNER_KEY: 'irrelevant' })).toThrow('SQUADS_SIGNER_KEY');
  });

  it('throws for ethereum when SAFE_SIGNER_KEY is missing', () => {
    expect(() => assertSignerKeysPresent('ethereum', {})).toThrow('SAFE_SIGNER_KEY');
  });
});

describe('checkSlippage()', () => {
  it('passes when no slippage_bps is set', () => {
    const order = { ...BASE_ORDER, slippage_bps: undefined };
    expect(checkSlippage(order).ok).toBe(true);
  });

  it('passes conviction tier at 200bps', () => {
    const order = { ...BASE_ORDER, tier: 'conviction', slippage_bps: 200 };
    expect(checkSlippage(order).ok).toBe(true);
  });

  it('fails conviction tier at 201bps', () => {
    const order = { ...BASE_ORDER, tier: 'conviction', slippage_bps: 201 };
    const result = checkSlippage(order);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('201bps exceeds max 200bps');
  });

  it('passes moonshot tier at 500bps', () => {
    const order = { ...BASE_ORDER, tier: 'moonshot', slippage_bps: 500 };
    expect(checkSlippage(order).ok).toBe(true);
  });

  it('fails moonshot tier at 501bps', () => {
    const order = { ...BASE_ORDER, tier: 'moonshot', slippage_bps: 501 };
    const result = checkSlippage(order);
    expect(result.ok).toBe(false);
  });

  it('applies 500bps limit for unknown tier (most permissive default)', () => {
    const order = { ...BASE_ORDER, tier: 'unknown_tier', slippage_bps: 500 };
    expect(checkSlippage(order).ok).toBe(true);
  });

  it('applies 500bps limit when tier is undefined', () => {
    const order: OrderInput = { ...BASE_ORDER };
    delete (order as Partial<OrderInput>).tier;
    const orderWithSlippage = { ...order, slippage_bps: 500 };
    expect(checkSlippage(orderWithSlippage).ok).toBe(true);
  });
});
