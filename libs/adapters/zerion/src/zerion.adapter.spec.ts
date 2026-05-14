/**
 * Unit tests for ZerionAdapter (SPEC §14, DoD §A, §F).
 *
 * Mocks `fetch` at the global boundary — no real network calls.
 *
 * Covers:
 *   - 200 happy path: realistic PnL JSON → correct ZerionPnlResult shape.
 *   - 429 → throws ZerionRateLimitError (NOT returns null).
 *   - Missing ZERION_API_KEY → returns null (legacy parity — does NOT throw).
 *   - Solana chain → returns null without any HTTP call.
 *   - AbortSignal-driven timeout: fetch rejects → bubbles up.
 *   - 500 / non-2xx → throws ZerionApiError.
 *   - Malformed JSON (no data.attributes) → returns null.
 *   - Basic auth header: Authorization = `Basic <base64(key + ':')>`, decoded.
 *   - Redaction: API key value never appears in any logger output.
 *   - Field mapping parity with legacy fetchZerionPnl in scripts/score-wallet.js.
 *   - relativeRealizedGain: null when field absent.
 *   - totalPnl: falls back to realizedPnl + unrealizedPnl when total_gain absent.
 *   - totalInvested: costBasis precedence rule.
 *   - ADR-0026: configService.get called with literal 'ZERION_API_KEY'.
 *
 * SPEC §4 #4: no signer-key env vars.
 * SPEC §4 #6: all config via ConfigService (no process.env).
 * ADR-0026: per-field config access only.
 * DoD §F: security — Basic auth value verified; key never logged.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { ZerionAdapter, ZerionRateLimitError, ZerionApiError } from './zerion.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(apiKey: string | undefined): ConfigService {
  return {
    get: vi.fn().mockReturnValue(apiKey),
  } as unknown as ConfigService;
}

type FetchSpy = ReturnType<typeof vi.fn>;

/**
 * Install a single-use fetch mock on global.fetch.
 * Returns the spy so callers can inspect call arguments.
 */
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

/**
 * Minimal realistic Zerion PnL API response with all optional fields present.
 */
function makeZerionPnlResponse(overrides: Record<string, unknown> = {}) {
  return {
    data: {
      attributes: {
        realized_gain: 12_500,
        unrealized_gain: 3_200,
        total_gain: 15_700,
        realized_cost_basis: 50_000,
        total_invested: 50_000,
        relative_realized_gain_percentage: 25.0,
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ZerionAdapter', () => {
  let adapter: ZerionAdapter;
  let configService: ConfigService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = global.fetch;
    configService = makeConfigService('test-zerion-key-xyz789');
    adapter = new ZerionAdapter(configService);
    // Suppress logger noise
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  describe('getPnl() — happy path (200)', () => {
    it('returns a ZerionPnlResult with source="zerion"', async () => {
      mockFetchOnce(200, makeZerionPnlResponse());

      const result = await adapter.getPnl('0xWallet123', { chain: 'base' });

      expect(result).not.toBeNull();
      expect(result?.source).toBe('zerion');
    });

    it('maps realizedPnl from realized_gain', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ realized_gain: 12_500 }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.realizedPnl).toBe(12_500);
    });

    it('maps unrealizedPnl from unrealized_gain', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ unrealized_gain: 3_200 }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.unrealizedPnl).toBe(3_200);
    });

    it('maps totalPnl from total_gain when present', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ total_gain: 15_700 }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.totalPnl).toBe(15_700);
    });

    it('maps relativeRealizedGain from relative_realized_gain_percentage', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ relative_realized_gain_percentage: 25.0 }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.relativeRealizedGain).toBe(25.0);
    });

    it('maps totalInvested from realized_cost_basis when costBasis > 0', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ realized_cost_basis: 50_000, total_invested: 999 }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      // costBasis = 50_000 > 0 → totalInvested = 50_000 (not 999)
      expect(result?.totalInvested).toBe(50_000);
    });

    it('falls back to total_invested when realized_cost_basis is absent', async () => {
      mockFetchOnce(
        200,
        makeZerionPnlResponse({
          realized_cost_basis: undefined,
          total_invested: 40_000,
        }),
      );

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.totalInvested).toBe(40_000);
    });

    it('defaults realizedPnl to 0 when realized_gain is absent', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ realized_gain: undefined }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.realizedPnl).toBe(0);
    });

    it('defaults unrealizedPnl to 0 when unrealized_gain is absent', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ unrealized_gain: undefined }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.unrealizedPnl).toBe(0);
    });

    it('computes totalPnl = realizedPnl + unrealizedPnl when total_gain is absent', async () => {
      // When total_gain is absent, adapter falls back to realized + unrealized
      mockFetchOnce(
        200,
        makeZerionPnlResponse({
          realized_gain: 1000,
          unrealized_gain: 500,
          total_gain: undefined,
        }),
      );

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      // total_gain absent → totalPnl = realizedPnl + unrealizedPnl = 1500
      expect(result?.totalPnl).toBe(1500);
    });

    it('sets relativeRealizedGain to null when field is absent', async () => {
      mockFetchOnce(200, makeZerionPnlResponse({ relative_realized_gain_percentage: undefined }));

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result?.relativeRealizedGain).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Realistic legacy-parity fixture
  // Taken from the structure of the legacy fetchZerionPnl return in
  // scripts/score-wallet.js:284-295. Verifies byte-identical field mapping.
  // -------------------------------------------------------------------------

  describe('getPnl() — legacy field-mapping parity fixture', () => {
    it('matches the exact output shape of legacy fetchZerionPnl', async () => {
      // Raw API response matching what Zerion returns in production
      const rawResponse = {
        data: {
          attributes: {
            realized_gain: 8_350,
            unrealized_gain: 1_200,
            total_gain: 9_550,
            realized_cost_basis: 25_000,
            total_invested: 25_000,
            relative_realized_gain_percentage: 33.4,
          },
        },
      };
      mockFetchOnce(200, rawResponse);

      const result = await adapter.getPnl('0xLegacyWallet', { chain: 'ethereum' });

      // Legacy fetchZerionPnl computed these values (score-wallet.js:284-295):
      //   realizedPnl = realized_gain = 8350
      //   unrealizedPnl = unrealized_gain = 1200
      //   costBasis = realized_cost_basis = 25000
      //   totalPnl = total_gain = 9550  (present → uses it directly)
      //   totalInvested = costBasis > 0 ? costBasis : total_invested = 25000
      //   relativeRealizedGain = relative_realized_gain_percentage = 33.4
      expect(result).toEqual({
        source: 'zerion',
        realizedPnl: 8_350,
        unrealizedPnl: 1_200,
        totalPnl: 9_550,
        totalInvested: 25_000,
        relativeRealizedGain: 33.4,
      });
    });
  });

  // -------------------------------------------------------------------------
  // Solana guard — no HTTP call
  // -------------------------------------------------------------------------

  describe('getPnl() — Solana chain guard', () => {
    it('returns null for chain="solana" without making any HTTP call', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;

      const result = await adapter.getPnl('SolanaAddress111', { chain: 'solana' });

      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });

    it('solana guard fires regardless of API key presence', async () => {
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new ZerionAdapter(cfgNoKey);
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;

      const result = await adapterNoKey.getPnl('SolAddr', { chain: 'solana' });

      expect(result).toBeNull();
      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Missing API key → null (NOT thrown error — legacy parity)
  // -------------------------------------------------------------------------

  describe('getPnl() — missing ZERION_API_KEY', () => {
    it('returns null when ZERION_API_KEY is absent (does NOT throw)', async () => {
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new ZerionAdapter(cfgNoKey);

      const result = await adapterNoKey.getPnl('0xWallet', { chain: 'base' });

      expect(result).toBeNull();
    });

    it('does NOT make any HTTP call when ZERION_API_KEY is absent', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new ZerionAdapter(cfgNoKey);

      await adapterNoKey.getPnl('0xWallet', { chain: 'base' });

      expect(spy).not.toHaveBeenCalled();
    });

    it('does NOT throw ZerionApiKeyMissingError to the caller (caller sees null)', async () => {
      const cfgNoKey = makeConfigService(undefined);
      const adapterNoKey = new ZerionAdapter(cfgNoKey);

      // Must resolve to null, must NOT reject
      await expect(adapterNoKey.getPnl('0xWallet', { chain: 'base' })).resolves.toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // HTTP 429 — throws ZerionRateLimitError
  // -------------------------------------------------------------------------

  describe('getPnl() — 429 rate limit', () => {
    it('throws ZerionRateLimitError on HTTP 429', async () => {
      mockFetchOnce(429, {});

      await expect(adapter.getPnl('0xWallet', { chain: 'base' })).rejects.toThrow(ZerionRateLimitError);
    });

    it('ZerionRateLimitError carries the request URL', async () => {
      mockFetchOnce(429, {});

      const err = await adapter.getPnl('0xWallet', { chain: 'base' }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ZerionRateLimitError);
      expect((err as ZerionRateLimitError).url).toContain('zerion.io');
    });

    it('ZerionRateLimitError name is "ZerionRateLimitError"', async () => {
      mockFetchOnce(429, {});

      const err = await adapter.getPnl('0xWallet', { chain: 'base' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ZerionRateLimitError);
      expect((err as ZerionRateLimitError).name).toBe('ZerionRateLimitError');
    });
  });

  // -------------------------------------------------------------------------
  // HTTP 500 / other non-2xx — throws ZerionApiError
  // -------------------------------------------------------------------------

  describe('getPnl() — non-2xx errors', () => {
    it('throws ZerionApiError on HTTP 500', async () => {
      mockFetchOnce(500, { error: 'Internal Server Error' });

      await expect(adapter.getPnl('0xWallet', { chain: 'base' })).rejects.toThrow(ZerionApiError);
    });

    it('ZerionApiError carries the HTTP status code', async () => {
      mockFetchOnce(503, {});

      const err = await adapter.getPnl('0xWallet', { chain: 'base' }).catch((e: Error) => e);
      expect(err).toBeInstanceOf(ZerionApiError);
      expect((err as ZerionApiError).status).toBe(503);
    });

    it('ZerionApiError carries the request URL', async () => {
      mockFetchOnce(502, {});

      const err = await adapter.getPnl('0xWallet', { chain: 'base' }).catch((e: Error) => e);
      expect((err as ZerionApiError).url).toContain('zerion.io');
    });

    it('throws ZerionApiError on HTTP 401 (bad key)', async () => {
      mockFetchOnce(401, { error: 'Unauthorized' });

      await expect(adapter.getPnl('0xWallet', { chain: 'base' })).rejects.toThrow(ZerionApiError);
    });
  });

  // -------------------------------------------------------------------------
  // Malformed JSON / missing attributes → returns null
  // -------------------------------------------------------------------------

  describe('getPnl() — malformed / empty response', () => {
    it('returns null when response has no data field', async () => {
      mockFetchOnce(200, {});

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result).toBeNull();
    });

    it('returns null when data field has no attributes', async () => {
      mockFetchOnce(200, { data: {} });

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result).toBeNull();
    });

    it('returns null when data is null', async () => {
      mockFetchOnce(200, { data: null });

      const result = await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // AbortSignal timeout — bubbles up
  // -------------------------------------------------------------------------

  describe('getPnl() — AbortSignal timeout', () => {
    it('propagates the abort error when fetch rejects due to timeout', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      mockFetchOnce(0, null, { throws: abortError });

      await expect(adapter.getPnl('0xWallet', { chain: 'base' })).rejects.toThrow('aborted');
    });

    it('passes the AbortSignal to fetch when opts.signal is provided', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());
      const signal = AbortSignal.timeout(5000);

      await adapter.getPnl('0xWallet', { chain: 'base', signal });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(callArgs[1]?.signal).toBe(signal);
    });
  });

  // -------------------------------------------------------------------------
  // Basic auth header verification (DoD §F)
  // SPEC §4: Authorization header must use Basic auth with base64(key + ':')
  // -------------------------------------------------------------------------

  describe('getPnl() — Basic auth header (DoD §F)', () => {
    it('sends Authorization header with Basic scheme', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['authorization']).toMatch(/^Basic /);
    });

    it('base64 value decodes to "<key>:" (empty password)', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      const authHeader = headers['authorization'] ?? '';
      const base64Part = authHeader.replace(/^Basic /, '');
      const decoded = Buffer.from(base64Part, 'base64').toString('utf8');

      // Must decode to exactly "<apiKey>:" — empty password, colon separator
      expect(decoded).toBe('test-zerion-key-xyz789:');
    });

    it('Authorization header matches the exact encoding from score-wallet.js:271-274', async () => {
      // Reproduce the legacy formula to verify identical output
      const apiKey = 'test-zerion-key-xyz789';
      const expectedHeader = `Basic ${Buffer.from(`${apiKey}:`).toString('base64')}`;

      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      expect(headers['authorization']).toBe(expectedHeader);
    });

    it('uses lowercase "authorization" header key (fetch standard)', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const callArgs = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = callArgs[1]?.headers as Record<string, string>;
      // The adapter uses lowercase 'authorization'
      expect(Object.keys(headers)).toContain('authorization');
    });
  });

  // -------------------------------------------------------------------------
  // Redaction: API key must never appear in logger output
  // -------------------------------------------------------------------------

  describe('getPnl() — redaction', () => {
    it('does NOT log the API key value in any logger output', async () => {
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

      mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const allOutput = logMessages.join('\n');
      expect(allOutput).not.toContain('test-zerion-key-xyz789');
    });

    it('does NOT log the base64-encoded API key either', async () => {
      const apiKey = 'test-zerion-key-xyz789';
      const encodedKey = Buffer.from(`${apiKey}:`).toString('base64');

      const logMessages: string[] = [];
      vi.spyOn(Logger.prototype, 'debug').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });
      vi.spyOn(Logger.prototype, 'warn').mockImplementation((msg: unknown) => {
        logMessages.push(String(msg));
      });

      mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(logMessages.join('\n')).not.toContain(encodedKey);
    });
  });

  // -------------------------------------------------------------------------
  // URL construction
  // -------------------------------------------------------------------------

  describe('getPnl() — URL construction', () => {
    it('targets the correct Zerion endpoint', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xDeadBeef', { chain: 'base' });

      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('api.zerion.io/v1/wallets/0xDeadBeef/pnl/');
    });

    it('includes currency=usd query parameter', async () => {
      const fetchSpy = mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const url = (fetchSpy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('currency=usd');
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0026: per-field config access
  // -------------------------------------------------------------------------

  describe('ADR-0026 — per-field config access', () => {
    it('calls configService.get with the literal string "ZERION_API_KEY"', async () => {
      mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      expect(configService.get).toHaveBeenCalledWith('ZERION_API_KEY');
    });

    it('does NOT call configService.get with an empty string or undefined key', async () => {
      mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const calls = (configService.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const badCalls = calls.filter((args) => !args[0] || args[0] === '');
      expect(badCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // SPEC §4 #4 — no signer-key reads
  // -------------------------------------------------------------------------

  describe('SPEC §4 #4 — no signer-key env vars', () => {
    it('does not call configService.get for SAFE_SIGNER_KEY', async () => {
      mockFetchOnce(200, makeZerionPnlResponse());

      await adapter.getPnl('0xWallet', { chain: 'base' });

      const calls = (configService.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const signerCalls = calls.filter((args) => args[0] === 'SAFE_SIGNER_KEY' || args[0] === 'SQUADS_SIGNER_KEY');
      expect(signerCalls).toHaveLength(0);
    });
  });
});
