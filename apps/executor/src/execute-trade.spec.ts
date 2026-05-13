/**
 * Unit tests for apps/executor/src/execute-trade.ts — dispatch layer.
 *
 * Covers:
 *   1. EXECUTOR_STUB_MODE=1 → delegates to stub without importing real SDK
 *   2. Solana in real mode  → returns not_yet_implemented_real_mode cleanly
 *   3. EVM in real mode     → delegates to execute-trade-evm (mocked)
 *
 * The real SDK import path is never hit in these tests because:
 *   - Stub tests short-circuit before the dynamic import.
 *   - EVM tests mock the dynamic import via vi.mock.
 *
 * @see SPEC §4 #4 — signer keys present in env by the time executeTrade() runs
 */
import { describe, it, expect, vi } from 'vitest';
import type { OrderInput, SuccessReceipt } from '@cclaw/execution';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_ORDER: OrderInput = {
  id: 'dispatch-test-001',
  action: 'buy',
  symbol: 'WETH',
  address: '0x4200000000000000000000000000000000000006',
  chain: 'base',
  amount: '100.00',
  entry_price: 2000,
  slippage_bps: 200,
  tier: 'conviction',
};

const SOLANA_ORDER: OrderInput = {
  ...BASE_ORDER,
  id: 'dispatch-solana-001',
  chain: 'solana',
  address: 'So11111111111111111111111111111111111111112',
  symbol: 'SOL',
};

const STUB_ENV = {
  EXECUTOR_STUB_MODE: '1',
  SAFE_SIGNER_KEY: 'fake-key-for-testing-only-deadbeef',
  SAFE_ID: 'test',
  REDIS_URL: 'redis://localhost:6379',
  ACTIVE_CHAINS: 'base',
};

const REAL_EVM_ENV = {
  EXECUTOR_STUB_MODE: '0',
  SAFE_SIGNER_KEY: 'fake-key-for-testing-only-deadbeef',
  SAFE_ADDRESS_BASE: '0x1234567890123456789012345678901234567890',
  RPC_BASE: 'https://mainnet.base.org',
  SAFE_ID: 'test',
  REDIS_URL: 'redis://localhost:6379',
  ACTIVE_CHAINS: 'base',
};

const REAL_SOLANA_ENV = {
  EXECUTOR_STUB_MODE: '0',
  SQUADS_SIGNER_KEY: 'fake-squads-key-deadbeef',
  SAFE_ID: 'test',
  REDIS_URL: 'redis://localhost:6379',
  ACTIVE_CHAINS: 'solana',
};

// ---------------------------------------------------------------------------
// Tests: stub mode — no real SDK import
// ---------------------------------------------------------------------------

describe('executeTrade() — stub mode short-circuit', () => {
  it('returns a success receipt when EXECUTOR_STUB_MODE=1 (EVM order)', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const receipt = await executeTrade(BASE_ORDER, STUB_ENV);
    expect(receipt.status).toBe('executed');
  });

  it('receipt tx_hash is deterministic (sha256-based stub)', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const r1 = await executeTrade(BASE_ORDER, STUB_ENV);
    const r2 = await executeTrade(BASE_ORDER, STUB_ENV);
    expect(r1.status).toBe('executed');
    if (r1.status === 'executed' && r2.status === 'executed') {
      expect(r1.tx_hash).toBe(r2.tx_hash);
    }
  });

  it('returns a success receipt when EXECUTOR_STUB_MODE=1 (Solana order)', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const solanaEnv = { ...STUB_ENV, SQUADS_SIGNER_KEY: 'fake-squads-key', SAFE_ID: 'test' };
    const receipt = await executeTrade(SOLANA_ORDER, solanaEnv);
    expect(receipt.status).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// Tests: Solana in real mode — not_yet_implemented_real_mode
// ---------------------------------------------------------------------------

describe('executeTrade() — Solana real mode stub', () => {
  it('returns failure receipt with not_yet_implemented_real_mode for solana', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const receipt = await executeTrade(SOLANA_ORDER, REAL_SOLANA_ENV);
    expect(receipt.status).toBe('failed');
    if (receipt.status === 'failed') {
      expect(receipt.error_kind).toBe('not_yet_implemented_real_mode');
    }
  });

  it('Solana failure receipt does not contain signer key value', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const sentinel = 'FAKE_SQUADS_KEY_SENTINEL_DEADBEEF12345';
    const receipt = await executeTrade(SOLANA_ORDER, { ...REAL_SOLANA_ENV, SQUADS_SIGNER_KEY: sentinel });
    expect(JSON.stringify(receipt)).not.toContain(sentinel);
  });
});

// ---------------------------------------------------------------------------
// Tests: EVM real mode — verify dynamic import delegation
// ---------------------------------------------------------------------------

describe('executeTrade() — EVM real mode delegation', () => {
  it('delegates to executeTradeEvm for non-stub EVM orders', async () => {
    // We mock the EVM module to avoid hitting real Safe SDK
    vi.doMock('./execute-trade-evm.js', () => ({
      executeTradeEvm: vi.fn().mockResolvedValue({
        status: 'executed',
        tx_hash: '0xmockedevmhash',
        block_number: 1,
        gas_used: 0,
        actual_amount_in: '100.00',
        actual_amount_out: 0.05,
        slippage_bps: 200,
        executed_at: new Date().toISOString(),
      } satisfies SuccessReceipt),
    }));

    // Re-import execute-trade.ts to pick up the mock
    // (vitest module isolation applies per test file)
    const { executeTrade } = await import('./execute-trade.js');
    const receipt = await executeTrade(BASE_ORDER, REAL_EVM_ENV);

    // If the mock was hit, we get the mocked hash back
    // If dynamic import resolution fails, it would throw
    expect(receipt.status).toBe('executed');
    if (receipt.status === 'executed') {
      expect(receipt.tx_hash).toBe('0xmockedevmhash');
    }

    vi.doUnmock('./execute-trade-evm.js');
  });
});

// ---------------------------------------------------------------------------
// Tests: receipt never contains signer key
// ---------------------------------------------------------------------------

describe('executeTrade() — signer key redaction', () => {
  it('stub receipt does not contain SAFE_SIGNER_KEY value', async () => {
    const { executeTrade } = await import('./execute-trade.js');
    const sentinel = 'FAKE_SIGNER_SENTINEL_DEADBEEF0000000000';
    const receipt = await executeTrade(BASE_ORDER, { ...STUB_ENV, SAFE_SIGNER_KEY: sentinel });
    expect(JSON.stringify(receipt)).not.toContain(sentinel);
  });
});
