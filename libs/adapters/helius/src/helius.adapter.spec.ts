/**
 * Unit tests for HeliusAdapter (SPEC §14, DoD §A, §F).
 *
 * Mocks `fetch` at the global boundary via vi.stubGlobal. No real network calls.
 *
 * Covers:
 *   - 200 happy path: returns HeliusTransaction[] with correct tokenTransfers shape.
 *   - Empty array body: returns [].
 *   - Missing HELIUS_API_KEY: returns null (legacy parity), no HTTP call.
 *   - Non-array body: returns null.
 *   - AbortSignal passed through to fetch.
 *   - Limit option encoded in URL.
 *   - 500 status: throws HeliusApiError.
 *   - 429 / 503: also throws HeliusApiError (no typed rate-limit error for Helius).
 *   - HeliusApiError carries redacted URL (no raw key).
 *   - Redaction critical: API key NEVER appears in any Logger call.
 *   - HeliusApiKeyMissingError: private method throws the typed error.
 *   - URL shape: api-key query param, /v0/addresses path.
 *   - ADR-0026: configService.get called with literal 'HELIUS_API_KEY'.
 *   - No process.env reads (SPEC §4 #6).
 *
 * SPEC §4 #4: no signer-key env vars.
 * SPEC §4 #6: all config via ConfigService.
 * ADR-0026: per-field config access only.
 * DoD §F: API key must not leak into any log line.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { HeliusAdapter, HeliusApiKeyMissingError, HeliusApiError } from './helius.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(key?: string): ConfigService {
  return {
    get: vi.fn().mockImplementation((field: string) => {
      if (field === 'HELIUS_API_KEY') return key ?? null;
      return null;
    }),
  } as unknown as ConfigService;
}

function makeFetchSpy(body: unknown, status = 200): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: vi.fn().mockResolvedValue(body),
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

/** Capture all Logger output into a string[] for redaction assertions. */
function captureLogOutput(): string[] {
  const messages: string[] = [];
  const capture = (msg: unknown) => messages.push(String(msg));
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(capture);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(capture);
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(capture);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(capture);
  return messages;
}

const REAL_API_KEY = 'test-helius-api-key-aaaaaaaaaaaaaaaa'; // pre-commit-allow

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('HeliusAdapter.getParsedTransactions', () => {
  // -------------------------------------------------------------------------
  // Happy path: 200 with array body
  // -------------------------------------------------------------------------

  describe('200 success', () => {
    it('returns an array of HeliusTransaction on success', async () => {
      const txFixture = [
        {
          signature: 'txSig123',
          timestamp: 1700000000,
          type: 'SWAP',
          tokenTransfers: [
            {
              mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              tokenSymbol: 'USDC',
              tokenName: 'USD Coin',
              fromUserAccount: 'wallet1',
              toUserAccount: 'wallet2',
              tokenAmount: '100.5',
            },
          ],
        },
      ];
      const fetchSpy = makeFetchSpy(txFixture);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('walletAddr123');

      expect(result).toEqual(txFixture);
      expect(fetchSpy).toHaveBeenCalledOnce();
    });

    it('includes the address in the request URL', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('theWalletAddress');

      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('theWalletAddress');
    });

    it('uses /v0/addresses path (Helius API shape)', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr123');

      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('/v0/addresses/');
      expect(calledUrl).toContain('/transactions');
    });

    it('includes api-key in the URL (Helius query-string convention)', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr');

      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('api-key=');
    });

    it('does NOT use Authorization header (Helius uses query-string auth)', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr');

      const callOpts = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
      const headers = callOpts?.headers as Record<string, string> | undefined;
      // Helius uses ?api-key=, not Authorization header
      if (headers) {
        expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
      }
    });

    it('returns empty array [] when Helius returns an empty array', async () => {
      makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('addr');
      expect(result).toEqual([]);
    });

    it('tokenTransfers shape is preserved verbatim', async () => {
      const transfers = [
        {
          mint: 'So11111111111111111111111111111111111111112',
          tokenSymbol: 'SOL',
          tokenName: 'Wrapped SOL',
          fromUserAccount: 'sender',
          toUserAccount: 'receiver',
          tokenAmount: 1.5,
        },
      ];
      makeFetchSpy([{ signature: 'sig', timestamp: 1000, type: 'SWAP', tokenTransfers: transfers }]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('addr');

      expect(result![0]!.tokenTransfers).toEqual(transfers);
    });
  });

  // -------------------------------------------------------------------------
  // Missing API key: returns null, no HTTP call
  // -------------------------------------------------------------------------

  describe('missing HELIUS_API_KEY', () => {
    it('returns null when HELIUS_API_KEY is absent (legacy parity)', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(undefined));

      const result = await adapter.getParsedTransactions('someAddr');

      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('returns null when HELIUS_API_KEY is empty string', async () => {
      const fetchSpy = makeFetchSpy([]);
      // empty string is falsy — treated as absent
      const adapter = new HeliusAdapter(makeConfigService(''));

      const result = await adapter.getParsedTransactions('addr');

      // Either null (skipped) or it threw: both are acceptable if key is absent
      // The adapter checks `if (!key)` which covers empty string
      expect(result).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('throws HeliusApiKeyMissingError from private getApiKey()', () => {
      const adapter = new HeliusAdapter(makeConfigService(undefined));
      // Access private method via cast — covers the error type for explicit callers
      const adapterPrivate = adapter as unknown as { getApiKey(): string };
      expect(() => adapterPrivate.getApiKey()).toThrow(HeliusApiKeyMissingError);
    });

    it('HeliusApiKeyMissingError has descriptive message containing HELIUS_API_KEY', () => {
      const err = new HeliusApiKeyMissingError();
      expect(err.message).toContain('HELIUS_API_KEY');
      expect(err.name).toBe('HeliusApiKeyMissingError');
    });
  });

  // -------------------------------------------------------------------------
  // Non-array body: returns null
  // -------------------------------------------------------------------------

  describe('non-array body', () => {
    it('returns null when Helius returns an object (not array)', async () => {
      makeFetchSpy({ message: 'no txs' });
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('addr');
      expect(result).toBeNull();
    });

    it('returns null when Helius returns null', async () => {
      makeFetchSpy(null);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('addr');
      expect(result).toBeNull();
    });

    it('returns null when Helius returns a string', async () => {
      makeFetchSpy('error occurred');
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const result = await adapter.getParsedTransactions('addr');
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // HTTP errors: 500, 429, 503
  // -------------------------------------------------------------------------

  describe('HTTP error responses', () => {
    it('throws HeliusApiError on 500', async () => {
      makeFetchSpy({}, 500);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await expect(adapter.getParsedTransactions('addr')).rejects.toThrow(HeliusApiError);
    });

    it('throws HeliusApiError on 429', async () => {
      makeFetchSpy({}, 429);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await expect(adapter.getParsedTransactions('addr')).rejects.toThrow(HeliusApiError);
    });

    it('throws HeliusApiError on 503', async () => {
      makeFetchSpy({}, 503);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await expect(adapter.getParsedTransactions('addr')).rejects.toThrow(HeliusApiError);
    });

    it('HeliusApiError carries the HTTP status', async () => {
      makeFetchSpy({}, 502);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const err = (await adapter.getParsedTransactions('addr').catch((e) => e)) as HeliusApiError;
      expect(err.status).toBe(502);
    });

    it('HeliusApiError.name is HeliusApiError', async () => {
      makeFetchSpy({}, 500);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const err = (await adapter.getParsedTransactions('addr').catch((e) => e)) as HeliusApiError;
      expect(err.name).toBe('HeliusApiError');
    });
  });

  // -------------------------------------------------------------------------
  // Redaction: API key must NEVER appear in any logger call (DoD §F)
  // -------------------------------------------------------------------------

  describe('API key redaction (DoD §F)', () => {
    it('raw api-key NEVER appears in any Logger call on success path', async () => {
      const messages = captureLogOutput();
      makeFetchSpy([{ signature: 's', timestamp: 1, type: 'SWAP', tokenTransfers: [] }]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr');

      const allOutput = messages.join('\n');
      expect(allOutput).not.toContain(REAL_API_KEY);
    });

    it('raw api-key NEVER appears in any Logger call on 500 error path', async () => {
      const messages = captureLogOutput();
      makeFetchSpy({}, 500);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr').catch(() => {});

      const allOutput = messages.join('\n');
      expect(allOutput).not.toContain(REAL_API_KEY);
    });

    it('HeliusApiError.redactedUrl does NOT contain the raw API key', async () => {
      makeFetchSpy({}, 503);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const err = (await adapter.getParsedTransactions('addr').catch((e) => e)) as HeliusApiError;

      expect(err.redactedUrl).not.toContain(REAL_API_KEY);
      expect(err.redactedUrl).toContain('[REDACTED]');
    });

    it('redactedUrl preserves the address and path (non-sensitive parts survive)', async () => {
      makeFetchSpy({}, 503);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const err = (await adapter.getParsedTransactions('specificAddress').catch((e) => e)) as HeliusApiError;

      expect(err.redactedUrl).toContain('specificAddress');
      expect(err.redactedUrl).toContain('helius.xyz');
    });

    it('raw api-key NEVER appears in Logger.error on abort/timeout path', async () => {
      const messages = captureLogOutput();
      const abortErr = new DOMException('The operation was aborted.', 'AbortError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr').catch(() => {});

      const allOutput = messages.join('\n');
      expect(allOutput).not.toContain(REAL_API_KEY);
    });

    it('raw api-key NEVER appears in Logger.debug on missing-key path', async () => {
      const messages = captureLogOutput();
      const adapter = new HeliusAdapter(makeConfigService(undefined));

      await adapter.getParsedTransactions('addr');

      // Any debug message about skipping should not mention a real key
      // (there is no key, but the test verifies the log path is clean)
      const allOutput = messages.join('\n');
      expect(allOutput).not.toContain(REAL_API_KEY);
    });
  });

  // -------------------------------------------------------------------------
  // AbortSignal + limit
  // -------------------------------------------------------------------------

  describe('opts.signal and opts.limit', () => {
    it('passes AbortSignal through to fetch', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));
      const controller = new AbortController();

      await adapter.getParsedTransactions('addr', { signal: controller.signal });

      const callOpts = fetchSpy.mock.calls[0][1] as RequestInit;
      expect(callOpts.signal).toBe(controller.signal);
    });

    it('bubbles up AbortError when signal fires', async () => {
      const abortErr = new DOMException('The operation was aborted.', 'AbortError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await expect(adapter.getParsedTransactions('addr')).rejects.toThrow('aborted');
    });

    it('bubbles up TimeoutError from AbortSignal.timeout', async () => {
      const timeoutErr = new DOMException('signal timed out', 'TimeoutError');
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      const err = (await adapter.getParsedTransactions('addr').catch((e) => e)) as Error;
      expect(err.name).toBe('TimeoutError');
    });

    it('encodes limit=10 in the URL when opts.limit=10', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr', { limit: 10 });

      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=10');
    });

    it('uses default limit=50 when opts.limit is not provided', async () => {
      const fetchSpy = makeFetchSpy([]);
      const adapter = new HeliusAdapter(makeConfigService(REAL_API_KEY));

      await adapter.getParsedTransactions('addr');

      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain('limit=50');
    });
  });

  // -------------------------------------------------------------------------
  // ADR-0026: per-field config access
  // -------------------------------------------------------------------------

  describe('ADR-0026 — per-field config access', () => {
    it('calls configService.get with the literal string "HELIUS_API_KEY"', async () => {
      const cfgSvc = makeConfigService(REAL_API_KEY);
      makeFetchSpy([]);
      const adapter = new HeliusAdapter(cfgSvc);

      await adapter.getParsedTransactions('addr');

      expect(cfgSvc.get).toHaveBeenCalledWith('HELIUS_API_KEY');
    });

    it('does NOT call configService.get with an empty string or undefined key', async () => {
      const cfgSvc = makeConfigService(REAL_API_KEY);
      makeFetchSpy([]);
      const adapter = new HeliusAdapter(cfgSvc);

      await adapter.getParsedTransactions('addr');

      const calls = (cfgSvc.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
      const badCalls = calls.filter((args) => !args[0] || args[0] === '');
      expect(badCalls).toHaveLength(0);
    });
  });
});
