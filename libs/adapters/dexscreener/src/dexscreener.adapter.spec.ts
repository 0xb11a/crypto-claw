/**
 * Unit tests for DexscreenerAdapter (DoD §A — tester depth pass).
 *
 * Uses vi.stubGlobal to mock global fetch — no real HTTP calls.
 *
 * Covers (SPEC §14, DoD §A):
 *   - getTokenPrice: returns price for highest-liquidity pair on matching chain.
 *   - getTokenPrice: falls back to all-chains when no same-chain pair exists.
 *   - getTokenPrice: returns null on HTTP 404.
 *   - getTokenPrice: returns null on HTTP 429 (rate limit).
 *   - getTokenPrice: returns null on HTTP 5xx server error.
 *   - getTokenPrice: returns null on fetch timeout / network error.
 *   - getTokenPrice: returns null when pairs is empty [].
 *   - getTokenPrice: returns null when pairs is null.
 *   - getTokenPrice: returns null when all pairs have priceUsd=0 or null.
 *   - getTokenPrices: empty array returns empty map without fetch.
 *   - getTokenPrices: single-address batch returns correct price (lowercased key).
 *   - getTokenPrices: batch of >30 addresses splits into multiple requests.
 *   - getTokenPrices: 5xx error on a batch returns empty partial map (does not throw).
 *   - getTokenPrices: picks highest-liquidity pair per chain in batch.
 *   - DEXSCREENER_TIMEOUT_MS: defaults to 15_000, respects custom config.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { DexscreenerAdapter } from './dexscreener.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(values: Record<string, unknown> = {}): ConfigService {
  return {
    get: vi.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function makePair(chainId: string, priceUsd: string, liquidityUsd: number) {
  return { chainId, priceUsd, liquidity: { usd: liquidityUsd } };
}

/** Build a mock Response-like object. */
function makeResponse(ok: boolean, status: number, body: unknown) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DexscreenerAdapter', () => {
  let adapter: DexscreenerAdapter;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    adapter = new DexscreenerAdapter(makeConfigService({ DEXSCREENER_TIMEOUT_MS: 15_000 }));
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // -------------------------------------------------------------------------
  // getTokenPrice — happy path
  // -------------------------------------------------------------------------

  describe('getTokenPrice — happy path', () => {
    it('returns the highest-liquidity price for the matching chain', async () => {
      const pairs = [
        makePair('base', '1.50', 500_000),
        makePair('base', '1.60', 200_000), // lower liquidity on 'base'
        makePair('ethereum', '1.55', 800_000), // higher liq but wrong chain
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBe(1.5); // highest liquidity on 'base' (500k > 200k)
    });

    it('falls back to all-chains pairs when no same-chain pairs exist', async () => {
      const pairs = [makePair('ethereum', '2.00', 900_000)];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBe(2.0);
    });

    it('returns the highest-liquidity pair when multiple all-chain fallback pairs exist', async () => {
      const pairs = [
        makePair('ethereum', '1.00', 100_000),
        makePair('polygon', '1.50', 900_000), // highest liquidity overall
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBe(1.5);
    });

    it('returns null when all priceUsd values are "0"', async () => {
      const pairs = [makePair('base', '0', 500_000)];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null when priceUsd is null in all pairs', async () => {
      const pairs = [{ chainId: 'base', priceUsd: null, liquidity: { usd: 500_000 } }];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getTokenPrice — error cases
  // -------------------------------------------------------------------------

  describe('getTokenPrice — error handling', () => {
    it('returns null on HTTP 404', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(false, 404, {}));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null on HTTP 429 (rate limit)', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(false, 429, {}));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null on HTTP 500 (server error)', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(false, 500, {}));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null on HTTP 503', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(false, 503, {}));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null on fetch network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('Network error'));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null on AbortError (timeout)', async () => {
      const abortErr = new DOMException('signal timed out', 'TimeoutError');
      fetchMock.mockRejectedValueOnce(abortErr);

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null when pairs is empty []', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs: [] }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null when pairs is null', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs: null }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });

    it('returns null when response body has no pairs key', async () => {
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, {}));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // getTokenPrices — batch behavior
  // -------------------------------------------------------------------------

  describe('getTokenPrices — batch behavior', () => {
    it('returns an empty map for empty input without calling fetch', async () => {
      const result = await adapter.getTokenPrices([], 'base');
      expect(result.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('returns price for a single address (lowercased key)', async () => {
      const pairs = [makePair('base', '3.00', 100_000)];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const result = await adapter.getTokenPrices(['0xABC'], 'base');
      // Key should be lowercased
      expect(result.get('0xabc')).toBe(3.0);
    });

    it('batches 30 addresses into one request', async () => {
      const addrs = Array.from({ length: 30 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
      const pairs = [makePair('base', '1.00', 100_000)];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      await adapter.getTokenPrices(addrs, 'base');

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('splits >30 addresses into multiple requests (batch limit = 30)', async () => {
      // 31 addresses → 2 batches (30 + 1)
      const addrs = Array.from({ length: 31 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
      const pairs = [makePair('base', '2.00', 50_000)];

      // First batch returns pairs; second batch also returns pairs
      fetchMock
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }))
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      await adapter.getTokenPrices(addrs, 'base');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('splits 60 addresses into exactly 2 requests (30+30)', async () => {
      const addrs = Array.from({ length: 60 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
      const pairs = [makePair('base', '1.50', 100_000)];

      fetchMock
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }))
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      await adapter.getTokenPrices(addrs, 'base');

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('splits 61 addresses into 3 requests (30+30+1)', async () => {
      const addrs = Array.from({ length: 61 }, (_, i) => `0x${i.toString(16).padStart(40, '0')}`);
      const pairs = [makePair('base', '1.50', 100_000)];

      fetchMock
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }))
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }))
        .mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      await adapter.getTokenPrices(addrs, 'base');

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('returns empty map when batch fetch returns 5xx error (does not throw)', async () => {
      const addrs = ['0xaddr1', '0xaddr2'];
      fetchMock.mockResolvedValueOnce(makeResponse(false, 500, {}));

      const result = await adapter.getTokenPrices(addrs, 'base');

      // Should not throw; returns empty map for the failing batch
      expect(result.size).toBe(0);
    });

    it('returns empty map when batch fetch throws network error (does not throw)', async () => {
      const addrs = ['0xaddr1'];
      fetchMock.mockRejectedValueOnce(new Error('connection reset'));

      const result = await adapter.getTokenPrices(addrs, 'base');

      expect(result.size).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Config: timeout
  // -------------------------------------------------------------------------

  describe('timeout configuration', () => {
    it('defaults to 15_000 ms when DEXSCREENER_TIMEOUT_MS is not set', () => {
      const adapterNoConfig = new DexscreenerAdapter(makeConfigService({}));
      const timeout = (adapterNoConfig as unknown as { timeoutMs: number }).timeoutMs;
      expect(timeout).toBe(15_000);
    });

    it('respects DEXSCREENER_TIMEOUT_MS from config', () => {
      const adapterCustom = new DexscreenerAdapter(makeConfigService({ DEXSCREENER_TIMEOUT_MS: 5_000 }));
      const timeout = (adapterCustom as unknown as { timeoutMs: number }).timeoutMs;
      expect(timeout).toBe(5_000);
    });

    it('passes a custom AbortSignal through to the fetch call', async () => {
      const pairs = [makePair('base', '1.00', 100_000)];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));
      const signal = AbortSignal.timeout(5000);

      await adapter.getTokenPrice('0xtoken', 'base', signal);

      // fetch was called with the provided signal
      const fetchCall = fetchMock.mock.calls[0] as [string, { signal: AbortSignal }];
      expect(fetchCall[1].signal).toBe(signal);
    });
  });

  // -------------------------------------------------------------------------
  // bestPrice: highest-liquidity selection
  // -------------------------------------------------------------------------

  describe('bestPrice — highest liquidity selection', () => {
    it('prefers chain-matching pairs over higher-liquidity cross-chain pairs', async () => {
      const pairs = [
        makePair('base', '1.00', 100_000), // chain match but lower liq
        makePair('ethereum', '2.00', 999_999), // no match but higher liq
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      // Prefer 'base' pair (chain match) even though it has lower liquidity
      expect(price).toBe(1.0);
    });

    it('picks the highest-liquidity pair when multiple same-chain pairs exist', async () => {
      const pairs = [
        makePair('base', '0.50', 10_000),
        makePair('base', '1.00', 500_000), // highest liq
        makePair('base', '0.75', 200_000),
      ];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBe(1.0);
    });

    it('returns null when liquidity is missing on all pairs (priceUsd still 0)', async () => {
      const pairs = [{ chainId: 'base', priceUsd: '0', liquidity: null }];
      fetchMock.mockResolvedValueOnce(makeResponse(true, 200, { pairs }));

      const price = await adapter.getTokenPrice('0xtoken', 'base');
      expect(price).toBeNull();
    });
  });
});
