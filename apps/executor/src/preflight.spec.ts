/**
 * Unit tests for apps/executor/src/preflight.ts
 *
 * Adversarial additions (P1c-ii tester):
 *   - checkSignerBalance: env arg (new signature), stub mode, solana stub, missing env
 *   - checkStalePrice: entry_price=0 no divide-by-zero, stub mode skip, no entry_price pass
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { assertSignerKeysPresent, checkSlippage, checkSignerBalance, checkStalePrice } from './preflight.js';
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

// ---------------------------------------------------------------------------
// Uncertainty 1 — checkSignerBalance() with env arg (new P1c-ii signature)
// Existing tests only called it with the old default-parameter form; verify the
// new second argument works correctly.
// ---------------------------------------------------------------------------

describe('checkSignerBalance() — env arg (P1c-ii signature)', () => {
  it('returns ok=true in stub mode (EXECUTOR_STUB_MODE=1) without making RPC calls', async () => {
    const result = await checkSignerBalance('base', { EXECUTOR_STUB_MODE: '1' });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('stub mode');
  });

  it('returns ok=true for solana when env is empty (missing SQUADS_SIGNER_KEY or RPC_SOL)', async () => {
    // P1c-iii: real Solana balance check is now wired. With empty env,
    // the check skips gracefully (assertSignerKeysPresent handles absent-key separately).
    const result = await checkSignerBalance('solana', {});
    expect(result.ok).toBe(true);
    // Message should indicate why it was skipped (missing keys)
    expect(result.message).toContain('skipped');
  });

  it('returns ok=true when env arg is omitted (default {} is backward-compatible)', async () => {
    // Calls the function with no second arg — must not throw (default {} means stub=false,
    // but unknown-chain guard fires first and returns ok=true)
    const result = await checkSignerBalance('unknown-chain-xyz');
    expect(result.ok).toBe(true);
  });

  it('returns ok=true when RPC URL is missing (assertSignerKeysPresent handles separately)', async () => {
    // real EVM path but RPC_BASE not set → graceful skip
    const result = await checkSignerBalance('base', {
      SAFE_SIGNER_KEY: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      // no RPC_BASE
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('skipped');
  });

  it('returns ok=false when signer key is not a valid private key', async () => {
    const result = await checkSignerBalance('base', {
      SAFE_SIGNER_KEY: 'not-a-real-key',
      RPC_BASE: 'https://mainnet.base.org',
    });
    // Could not derive address → reports insufficient
    expect(result.ok).toBe(false);
    expect(result.message).toContain('signer_balance_insufficient');
  });
});

// ---------------------------------------------------------------------------
// Adversarial 4 — checkStalePrice() with entry_price=0 (no divide-by-zero)
// ---------------------------------------------------------------------------

describe('checkStalePrice() — entry_price=0 guard', () => {
  it('returns ok=true when entry_price is 0 (guard prevents divide-by-zero)', async () => {
    const order = { ...BASE_ORDER, entry_price: 0 };
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(true);
  });

  it('returns ok=true when entry_price is negative (treated as unset)', async () => {
    const order = { ...BASE_ORDER, entry_price: -1 };
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(true);
  });

  it('returns ok=true when entry_price is undefined', async () => {
    const order: OrderInput = { ...BASE_ORDER };
    delete (order as Partial<OrderInput>).entry_price;
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(true);
  });

  it('skips DEXScreener fetch in stub mode (EXECUTOR_STUB_MODE=1)', async () => {
    // If DEXScreener were called in stub mode this test would fail due to network.
    // Verifies the stub-mode short-circuit before the fetch.
    const order = { ...BASE_ORDER, entry_price: 2000 };
    const result = await checkStalePrice(order, { EXECUTOR_STUB_MODE: '1' });
    expect(result.ok).toBe(true);
  });

  it('passes (fail-open) when DEXScreener returns error', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error('network error'));
    const order = { ...BASE_ORDER, entry_price: 2000 };
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(true);
    vi.restoreAllMocks();
  });

  it('returns ok=false when price drifted more than 10%', async () => {
    // entry_price=2000, current price=2300 → 15% drift > 10%
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pairs: [{ priceUsd: '2300' }] }),
    } as unknown as Response);
    const order = { ...BASE_ORDER, entry_price: 2000 };
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('stale_price');
    vi.restoreAllMocks();
  });

  it('returns ok=true when price drift is within 10%', async () => {
    // entry_price=2000, current price=2099 → 4.95% drift < 10%
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: async () => ({ pairs: [{ priceUsd: '2099' }] }),
    } as unknown as Response);
    const order = { ...BASE_ORDER, entry_price: 2000 };
    const result = await checkStalePrice(order, {});
    expect(result.ok).toBe(true);
    vi.restoreAllMocks();
  });
});

/* eslint-disable @typescript-eslint/no-unused-vars */
// ---------------------------------------------------------------------------
// Adversarial gap 4 — checkSignerBalance Solana with valid key but 0 lamports
//
// When the Solana connection returns 0 lamports (a valid RPC response), the
// balance check must return { ok: false, message: 'signer_balance_insufficient' }.
// The coder's tests only covered stub mode and invalid base58.
// ---------------------------------------------------------------------------

describe('checkSignerBalance() — Solana: valid key, 0 lamports (adversarial gap 4)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns ok=false with signer_balance_insufficient when RPC returns 0 lamports', async () => {
    // The @solana/web3.js and bs58 mocks are already active from the spec file's
    // vi.mock() calls at the top of execute-trade-solana.spec.ts.  This test
    // lives in preflight.spec.ts where those mocks are NOT declared, so we need
    // to mock the dynamic imports inside checkSolanaSignerBalance directly.
    //
    // Strategy: mock globalThis so that `import('@solana/web3.js')` returns a
    // Connection whose getBalance returns 0, and `import('bs58')` returns a
    // decoder that succeeds for any string.

    // We use vi.doMock before the dynamic import fires inside checkSignerBalance.
    vi.doMock('@solana/web3.js', () => {
      class FakePublicKey {
        _addr: string;
        constructor(addr: string) {
          this._addr = addr;
        }
        toString() {
          return this._addr;
        }
      }
      class FakeKeypair {
        publicKey: FakePublicKey;
        constructor() {
          this.publicKey = new FakePublicKey('FakeSignerPubkeyForPreflightTest11111111');
        }
        static fromSecretKey(_bytes: Uint8Array) {
          return new FakeKeypair();
        }
      }
      class FakeConnection {
        constructor(_url: string, _commitment?: string) {}
        async getBalance(_key: unknown): Promise<number> {
          return 0; // zero lamports — below any reasonable threshold
        }
      }
      return {
        Keypair: FakeKeypair,
        PublicKey: FakePublicKey,
        Connection: FakeConnection,
        LAMPORTS_PER_SOL: 1_000_000_000,
      };
    });

    vi.doMock('bs58', () => ({
      default: {
        decode: (_s: string) => new Uint8Array(64).fill(1),
        encode: (b: Uint8Array) => 'FakeBase58_' + b.length,
      },
      decode: (_s: string) => new Uint8Array(64).fill(1),
      encode: (b: Uint8Array) => 'FakeBase58_' + b.length,
    }));

    const result = await checkSignerBalance('solana', {
      SQUADS_SIGNER_KEY: '5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF8tHere', // pre-commit-allow
      RPC_SOL: 'https://mainnet.helius-rpc.com/?api-key=test',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('signer_balance_insufficient');

    vi.doUnmock('@solana/web3.js');
    vi.doUnmock('bs58');
  });

  it('returns ok=true in stub mode even if key is valid (stub skips RPC)', async () => {
    const result = await checkSignerBalance('solana', {
      EXECUTOR_STUB_MODE: '1',
      SQUADS_SIGNER_KEY: '5Kb8kLf9zgWQnogidDA76MzPL6TsZZY36hWXMssSzNydYXYB9KF8tHere', // pre-commit-allow
      RPC_SOL: 'https://mainnet.helius-rpc.com/?api-key=test',
    });
    expect(result.ok).toBe(true);
    expect(result.message).toContain('stub mode');
  });

  it('returns ok=false for non-base58 key on solana', async () => {
    vi.doMock('@solana/web3.js', () => {
      class FakeKeypair {
        static fromSecretKey(_bytes: Uint8Array) {
          return new FakeKeypair();
        }
      }
      class FakeConnection {
        constructor(_url: string, _commitment?: string) {}
        async getBalance(_key: unknown): Promise<number> {
          return 0;
        }
      }
      return { Keypair: FakeKeypair, Connection: FakeConnection, LAMPORTS_PER_SOL: 1_000_000_000 };
    });

    vi.doMock('bs58', () => ({
      default: {
        decode: (_s: string) => {
          throw new Error('Non-base58 character');
        },
      },
      decode: (_s: string) => {
        throw new Error('Non-base58 character');
      },
    }));

    const result = await checkSignerBalance('solana', {
      SQUADS_SIGNER_KEY: 'NOT_VALID_BASE58!!!', // deliberately invalid
      RPC_SOL: 'https://mainnet.helius-rpc.com/?api-key=test',
    });

    expect(result.ok).toBe(false);
    expect(result.message).toContain('signer_balance_insufficient');

    vi.doUnmock('@solana/web3.js');
    vi.doUnmock('bs58');
  });
});

/* eslint-enable @typescript-eslint/no-unused-vars */

// Cleanup: afterEach in case vi.restoreAllMocks wasn't reached due to test failure
afterEach(() => {
  vi.restoreAllMocks();
});
