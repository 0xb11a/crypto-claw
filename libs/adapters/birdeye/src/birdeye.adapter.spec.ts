/**
 * Unit tests for BirdeyeAdapter (SPEC §14, DoD §A).
 *
 * Mocks `fetch` at the global boundary (SPEC §14: mock HTTP, not the adapter
 * class). No real network calls are made.
 *
 * Covers:
 *   - 200 happy path: getTopGainersPerChain produces flat list with correct shape.
 *   - 429: throws BirdeyeRateLimitError.
 *   - Missing BIRDEYE_API_KEY: throws BirdeyeApiKeyMissingError.
 *   - Empty chains array: returns [] without any HTTP call.
 *   - Partial failure: one chain 200, one chain 500 → returns successes, logs warn.
 *   - All chains fail: throws (BullMQ can retry).
 *   - AbortSignal-driven timeout: fetch rejects → bubbles up.
 *   - Malformed Birdeye JSON (no data.items): returns [] for that chain.
 *   - Redaction: X-API-KEY value never appears in logger output.
 *   - getTraderRank: throws NotImplementedError (PR-A stub).
 *   - getTokenTopTraders: throws NotImplementedError (PR-A stub).
 *
 * SPEC §4 #4: no signer-key env vars.
 * SPEC §4 #6: all config via ConfigService (no process.env).
 * ADR-0026: per-field config access only.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  BirdeyeAdapter,
  BirdeyeApiKeyMissingError,
  BirdeyeRateLimitError,
  BirdeyeApiError,
  NotImplementedError,
} from './birdeye.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(apiKey: string | undefined): ConfigService {
  return {
    get: vi.fn().mockReturnValue(apiKey),
  } as unknown as ConfigService;
}

function makeBirdeyeResponse(items: Array<{ address?: string; symbol?: string }>) {
  return {
    data: { items },
  };
}

// `fetch` is absent from `typeof globalThis` under "lib": ["ES2022"] (no DOM),
// so vi.spyOn's generic inference produces an incompatible MockInstance type.
// We use vi.fn() to install the mock directly on global.fetch — vi.restoreAllMocks()
// in afterEach still clears it because we track the original value ourselves.
type FetchSpy = ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown, opts: { throws?: Error } = {}): FetchSpy {
  const spy = vi.fn();
  if (opts.throws) {
    spy.mockRejectedValueOnce(opts.throws);
  } else {
    spy.mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  }
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

function mockFetchPerCall(calls: Array<{ status: number; body: unknown } | { throws: Error }>): FetchSpy {
  const spy = vi.fn();
  for (const call of calls) {
    if ('throws' in call) {
      spy.mockRejectedValueOnce(call.throws);
    } else {
      spy.mockResolvedValueOnce(new Response(JSON.stringify(call.body), { status: call.status }));
    }
  }
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('BirdeyeAdapter', () => {
  let adapter: BirdeyeAdapter;
  let configService: ConfigService;
  let fetchSpy: FetchSpy;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    configService = makeConfigService('test-api-key-abc123');
    adapter = new BirdeyeAdapter(configService);
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path: getTopGainersPerChain
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — happy path', () => {
    it('returns a flat list with { address, chain, symbol } for a single chain', async () => {
      fetchSpy = mockFetchOnce(
        200,
        makeBirdeyeResponse([
          { address: '0xTokenA', symbol: 'TKNA' },
          { address: '0xTokenB', symbol: 'TKNB' },
        ]),
      );

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({ address: '0xTokenA', chain: 'base', symbol: 'TKNA' });
      expect(result[1]).toEqual({ address: '0xTokenB', chain: 'base', symbol: 'TKNB' });
    });

    it('returns a flat merged list for two chains with one HTTP call per chain', async () => {
      fetchSpy = mockFetchPerCall([
        { status: 200, body: makeBirdeyeResponse([{ address: '0xBaseToken', symbol: 'BASE' }]) },
        { status: 200, body: makeBirdeyeResponse([{ address: 'SolanaToken111', symbol: 'SOL_GAIN' }]) },
      ]);

      const result = await adapter.getTopGainersPerChain(['base', 'solana']);

      // Two HTTP calls made
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(result).toHaveLength(2);

      const baseEntry = result.find((r) => r.chain === 'base');
      const solEntry = result.find((r) => r.chain === 'solana');
      expect(baseEntry).toEqual({ address: '0xBaseToken', chain: 'base', symbol: 'BASE' });
      expect(solEntry).toEqual({ address: 'SolanaToken111', chain: 'solana', symbol: 'SOL_GAIN' });
    });

    it('sets the X-API-KEY header on each request', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['base']);

      expect(fetchSpy).toHaveBeenCalledOnce();
      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['X-API-KEY']).toBe('test-api-key-abc123');
    });

    it('passes the AbortSignal to fetch when opts.signal is provided', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([]));
      const signal = AbortSignal.timeout(5000);

      await adapter.getTopGainersPerChain(['base'], { signal });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]?.signal).toBe(signal);
    });

    it('filters out items without an address field', async () => {
      fetchSpy = mockFetchOnce(
        200,
        makeBirdeyeResponse([
          { symbol: 'NO_ADDRESS' }, // no address — should be filtered
          { address: '0xGoodToken', symbol: 'GOOD' },
        ]),
      );

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result).toHaveLength(1);
      expect(result[0]?.address).toBe('0xGoodToken');
    });

    it('uses empty string for symbol when symbol is absent', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([{ address: '0xNoSymbol' }]));

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result[0]?.symbol).toBe('');
    });
  });

  // -------------------------------------------------------------------------
  // Empty chains
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — empty chains array', () => {
    it('returns [] without making any HTTP call', async () => {
      fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;

      const result = await adapter.getTopGainersPerChain([]);

      expect(result).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error: 429 rate limit
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — 429 rate limit', () => {
    it('throws BirdeyeRateLimitError when Birdeye returns 429', async () => {
      mockFetchOnce(429, {});

      await expect(adapter.getTopGainersPerChain(['base'])).rejects.toThrow(BirdeyeRateLimitError);
    });

    it('BirdeyeRateLimitError contains the URL', async () => {
      mockFetchOnce(429, {});

      const err = await adapter.getTopGainersPerChain(['base']).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BirdeyeRateLimitError);
      expect((err as BirdeyeRateLimitError).url).toContain('birdeye');
    });

    it('propagates first error when all chains hit 429', async () => {
      mockFetchPerCall([
        { status: 429, body: {} },
        { status: 429, body: {} },
      ]);

      await expect(adapter.getTopGainersPerChain(['base', 'solana'])).rejects.toThrow(BirdeyeRateLimitError);
    });
  });

  // -------------------------------------------------------------------------
  // HTTP error: non-2xx, non-429
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — non-2xx errors', () => {
    it('throws BirdeyeApiError when Birdeye returns 500', async () => {
      mockFetchOnce(500, { error: 'Internal Server Error' });

      await expect(adapter.getTopGainersPerChain(['base'])).rejects.toThrow(BirdeyeApiError);
    });

    it('BirdeyeApiError carries the status code', async () => {
      mockFetchOnce(503, {});

      const err = await adapter.getTopGainersPerChain(['base']).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BirdeyeApiError);
      expect((err as BirdeyeApiError).status).toBe(503);
    });
  });

  // -------------------------------------------------------------------------
  // Partial failure: one chain succeeds, one fails
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — partial failure', () => {
    it('returns successful chain results when one chain returns 500', async () => {
      // base: success; solana: 500
      mockFetchPerCall([
        { status: 200, body: makeBirdeyeResponse([{ address: '0xBaseOk', symbol: 'BOK' }]) },
        { status: 500, body: {} },
      ]);

      const result = await adapter.getTopGainersPerChain(['base', 'solana']);

      expect(result).toHaveLength(1);
      expect(result[0]?.chain).toBe('base');
      expect(result[0]?.address).toBe('0xBaseOk');
    });

    it('does NOT throw when at least one chain succeeds', async () => {
      mockFetchPerCall([
        { status: 500, body: {} },
        { status: 200, body: makeBirdeyeResponse([{ address: '0xSolOk', symbol: 'SOK' }]) },
      ]);

      await expect(adapter.getTopGainersPerChain(['base', 'solana'])).resolves.toHaveLength(1);
    });

    it('throws when ALL chains fail (last-resort for BullMQ retry)', async () => {
      mockFetchPerCall([
        { status: 500, body: {} },
        { status: 500, body: {} },
      ]);

      await expect(adapter.getTopGainersPerChain(['base', 'solana'])).rejects.toBeInstanceOf(Error);
    });

    it('logs a warn for the failed chain (observable in adapter output)', async () => {
      const warnSpy = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
      mockFetchPerCall([
        { status: 200, body: makeBirdeyeResponse([{ address: '0xOk', symbol: 'OK' }]) },
        { status: 500, body: {} },
      ]);

      await adapter.getTopGainersPerChain(['base', 'solana']);

      expect(warnSpy).toHaveBeenCalledOnce();
      const warnMsg = warnSpy.mock.calls[0]?.[0] as string;
      expect(warnMsg).toContain('solana');
    });
  });

  // -------------------------------------------------------------------------
  // Malformed JSON: no data.items
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — malformed response', () => {
    it('returns [] for a chain when response has no data.items', async () => {
      mockFetchOnce(200, {}); // no data field at all

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result).toEqual([]);
    });

    it('returns [] when data.items is missing but data field exists', async () => {
      mockFetchOnce(200, { data: {} });

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result).toEqual([]);
    });

    it('returns [] when data.items is an empty array', async () => {
      mockFetchOnce(200, makeBirdeyeResponse([]));

      const result = await adapter.getTopGainersPerChain(['base']);

      expect(result).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // Missing API key
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — missing API key', () => {
    it('throws BirdeyeApiKeyMissingError when BIRDEYE_API_KEY is absent', async () => {
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new BirdeyeAdapter(cfgNoKey);

      await expect(adapterNoKey.getTopGainersPerChain(['base'])).rejects.toThrow(BirdeyeApiKeyMissingError);
    });

    it('BirdeyeApiKeyMissingError message is descriptive', async () => {
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new BirdeyeAdapter(cfgNoKey);

      const err = await adapterNoKey.getTopGainersPerChain(['base']).catch((e: Error) => e);
      expect(err).toBeInstanceOf(BirdeyeApiKeyMissingError);
      if (!(err instanceof Error)) throw new Error('expected Error but got a non-Error value');
      expect(err.message).toContain('BIRDEYE_API_KEY');
    });

    it('does NOT make any HTTP call when API key is missing', async () => {
      fetchSpy = vi.fn();
      global.fetch = fetchSpy as unknown as typeof fetch;
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new BirdeyeAdapter(cfgNoKey);

      await adapterNoKey.getTopGainersPerChain(['base']).catch(() => {});

      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // AbortSignal timeout
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — AbortSignal timeout', () => {
    it('bubbles up the abort error when fetch rejects due to timeout', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(abortError);

      await expect(adapter.getTopGainersPerChain(['base'])).rejects.toThrow('aborted');
    });
  });

  // -------------------------------------------------------------------------
  // Redaction: X-API-KEY must not appear in logger output
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — redaction', () => {
    it('does NOT log the X-API-KEY header value in any log call', async () => {
      const logMessages: string[] = [];
      vi.spyOn(Logger.prototype, 'debug').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });
      vi.spyOn(Logger.prototype, 'log').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });
      vi.spyOn(Logger.prototype, 'error').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });

      mockFetchOnce(200, makeBirdeyeResponse([{ address: '0xA', symbol: 'A' }]));

      await adapter.getTopGainersPerChain(['base']);

      const allOutput = logMessages.join('\n');
      expect(allOutput).not.toContain('test-api-key-abc123');
    });
  });

  // -------------------------------------------------------------------------
  // URL construction
  // -------------------------------------------------------------------------

  describe('getTopGainersPerChain() — URL construction', () => {
    it('encodes the chain name in the query string', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['base']);

      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('chain=base');
      expect(url).toContain('sort_by=price_change_24h_percent');
      expect(url).toContain('sort_type=desc');
    });

    it('maps internal chain names to Birdeye chain identifiers (solana → solana)', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['solana']);

      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('chain=solana');
    });

    it('passes through unknown chain names as-is', async () => {
      fetchSpy = mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['polygon']);

      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('chain=polygon');
    });
  });

  // -------------------------------------------------------------------------
  // PR-A stubs: getTraderRank and getTokenTopTraders
  // -------------------------------------------------------------------------

  describe('getTraderRank() — PR-A stub', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.getTraderRank('0xWallet', 'base')).rejects.toThrow(NotImplementedError);
    });

    it('error message mentions the method name', async () => {
      const err = await adapter.getTraderRank('0xWallet', 'base').catch((e: Error) => e);
      if (!(err instanceof Error)) throw new Error('expected Error but got a non-Error value');
      expect(err.message).toContain('getTraderRank');
    });
  });

  describe('getTokenTopTraders() — PR-A stub', () => {
    it('throws NotImplementedError', async () => {
      await expect(adapter.getTokenTopTraders('0xToken', 'base')).rejects.toThrow(NotImplementedError);
    });

    it('error message mentions the method name', async () => {
      const err = await adapter.getTokenTopTraders('0xToken', 'base').catch((e: Error) => e);
      if (!(err instanceof Error)) throw new Error('expected Error but got a non-Error value');
      expect(err.message).toContain('getTokenTopTraders');
    });
  });

  // -------------------------------------------------------------------------
  // ConfigService: BIRDEYE_API_KEY accessed per-field (ADR-0026)
  // -------------------------------------------------------------------------

  describe('ADR-0026 — per-field config access', () => {
    it('calls configService.get with the literal string "BIRDEYE_API_KEY"', async () => {
      mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['base']);

      expect(configService.get).toHaveBeenCalledWith('BIRDEYE_API_KEY');
    });

    it('does NOT call configService.get with an empty string or undefined', async () => {
      mockFetchOnce(200, makeBirdeyeResponse([]));

      await adapter.getTopGainersPerChain(['base']);

      const calls = (configService.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const badCalls = calls.filter((args) => !args[0] || args[0] === '');
      expect(badCalls).toHaveLength(0);
    });
  });
});
