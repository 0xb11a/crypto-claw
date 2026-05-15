/**
 * Unit tests for SafeTxServiceAdapter (SPEC §14, DoD §A).
 *
 * Mocks `fetch` at the global boundary (SPEC §14: mock HTTP, not the adapter).
 * No real network calls. No auth headers (Safe TxService is public — no bearer token).
 *
 * Covers:
 *   getSafeInfo:
 *     - 200 happy path: returns normalised SafeInfo with correct fields.
 *     - Non-EVM chain: throws SafeTxServiceChainError.
 *     - 404: throws SafeTxServiceApiError with status=404.
 *     - 429: retries once, second 200 → success.
 *     - 429 + 429 (double): throws SafeTxServiceRateLimitError.
 *     - 5xx: throws SafeTxServiceApiError.
 *     - AbortSignal: abort error bubbles up.
 *     - Malformed JSON (null data): returns safe defaults (owners=[], threshold=0).
 *     - URL format: correct endpoint path.
 *     - No bearer token in any log line (Safe TxService is public).
 *
 *   getTransaction:
 *     - 200 happy path: executed+successful → correct SafeTxStatus shape.
 *     - Not executed: executed=false, isSuccessful=false.
 *     - 404: throws SafeTxServiceApiError.
 *     - 429 retry: second 200 → success.
 *     - URL includes safeTxHash in path.
 *
 * SPEC §4 #4 — no signer keys.
 * SPEC §4 #6 — no process.env reads.
 * DoD §A — tests fail before, pass after.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import {
  SafeTxServiceAdapter,
  SafeTxServiceChainError,
  SafeTxServiceRateLimitError,
  SafeTxServiceApiError,
} from './safe-tx-service.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchSpy = ReturnType<typeof vi.fn>;

function mockFetchOnce(status: number, body: unknown): FetchSpy {
  const spy = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(body), { status }));
  global.fetch = spy as unknown as typeof fetch;
  return spy;
}

function mockFetchSequence(calls: Array<{ status: number; body: unknown } | { throws: Error }>): FetchSpy {
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

function makeSafeInfoBody(overrides: Record<string, unknown> = {}) {
  return {
    owners: ['0xOwnerA', '0xOwnerB'],
    threshold: 2,
    modules: [],
    nonce: 5,
    ...overrides,
  };
}

function makeTxBody(overrides: Record<string, unknown> = {}) {
  return {
    isExecuted: true,
    isSuccessful: true,
    transactionHash: '0xOnChainHash',
    confirmations: [{ owner: '0xOwnerA' }, { owner: '0xOwnerB' }],
    confirmationsRequired: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SafeTxServiceAdapter', () => {
  let adapter: SafeTxServiceAdapter;
  let originalFetch: typeof globalThis.fetch;
  let logMessages: string[];

  beforeEach(() => {
    originalFetch = global.fetch;
    adapter = new SafeTxServiceAdapter();
    logMessages = [];
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
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — happy path
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — happy path', () => {
    it('returns normalised SafeInfo with owners, threshold, modules, nonce', async () => {
      mockFetchOnce(200, makeSafeInfoBody());

      const result = await adapter.getSafeInfo('base', '0xSafeAddr');

      expect(result.owners).toEqual(['0xOwnerA', '0xOwnerB']);
      expect(result.threshold).toBe(2);
      expect(result.modules).toEqual([]);
      expect(result.nonce).toBe(5);
    });

    it('returns safe defaults when JSON has no owners field', async () => {
      mockFetchOnce(200, {});

      const result = await adapter.getSafeInfo('base', '0xSafeAddr');

      expect(result.owners).toEqual([]);
      expect(result.threshold).toBe(0);
      expect(result.modules).toEqual([]);
      expect(result.nonce).toBe(0);
    });

    it('passes safeAddress in URL path', async () => {
      const spy = mockFetchOnce(200, makeSafeInfoBody());

      await adapter.getSafeInfo('base', '0xTestSafe');

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('/api/v1/safes/0xTestSafe/');
    });

    it('uses GET method with accept:application/json header', async () => {
      const spy = mockFetchOnce(200, makeSafeInfoBody());

      await adapter.getSafeInfo('base', '0xSafe');

      const [, init] = spy.mock.calls[0] as [string, RequestInit];
      expect(init.method).toBe('GET');
      expect((init.headers as Record<string, string>)['accept']).toBe('application/json');
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — non-EVM chain
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — non-EVM chain', () => {
    it('throws SafeTxServiceChainError for non-EVM chain', async () => {
      await expect(adapter.getSafeInfo('solana', '0xAddr')).rejects.toThrow(SafeTxServiceChainError);
    });

    it('SafeTxServiceChainError carries the chain name', async () => {
      const err = await adapter.getSafeInfo('solana', '0xAddr').catch((e: Error) => e);
      expect(err).toBeInstanceOf(SafeTxServiceChainError);
      expect((err as SafeTxServiceChainError).chain).toBe('solana');
    });

    it('does NOT make any HTTP call for non-EVM chain', async () => {
      const spy = vi.fn();
      global.fetch = spy as unknown as typeof fetch;

      await adapter.getSafeInfo('solana', '0xAddr').catch(() => {});

      expect(spy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — 404
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — 404', () => {
    it('throws SafeTxServiceApiError with status=404', async () => {
      mockFetchOnce(404, { message: 'Not found' });

      const err = await adapter.getSafeInfo('base', '0xMissing').catch((e: Error) => e);
      expect(err).toBeInstanceOf(SafeTxServiceApiError);
      expect((err as SafeTxServiceApiError).status).toBe(404);
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — 429 retry
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — 429 retry', () => {
    it('retries once on 429 and succeeds on second attempt', async () => {
      // Use real timers but override setTimeout to avoid real 2s wait.
      // The adapter awaits a Promise(setTimeout(r, 2000)); we fake it with a spy.
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
          // Execute immediately with 0 delay
          return origSetTimeout(fn as (...a: unknown[]) => void, 0, ...args) as unknown as ReturnType<
            typeof setTimeout
          >;
        },
      );

      const spy = mockFetchSequence([
        { status: 429, body: {} },
        { status: 200, body: makeSafeInfoBody() },
      ]);

      const result = await adapter.getSafeInfo('base', '0xSafe');

      expect(spy).toHaveBeenCalledTimes(2);
      expect(result.threshold).toBe(2);
    });

    it('throws SafeTxServiceRateLimitError when both attempts hit 429', async () => {
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
          return origSetTimeout(fn as (...a: unknown[]) => void, 0, ...args) as unknown as ReturnType<
            typeof setTimeout
          >;
        },
      );

      mockFetchSequence([
        { status: 429, body: {} },
        { status: 429, body: {} },
      ]);

      await expect(adapter.getSafeInfo('base', '0xSafe')).rejects.toThrow(SafeTxServiceRateLimitError);
    });

    it('SafeTxServiceRateLimitError carries the URL', async () => {
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
          return origSetTimeout(fn as (...a: unknown[]) => void, 0, ...args) as unknown as ReturnType<
            typeof setTimeout
          >;
        },
      );

      mockFetchSequence([
        { status: 429, body: {} },
        { status: 429, body: {} },
      ]);

      const err = await adapter.getSafeInfo('base', '0xSafe').catch((e: Error) => e);

      expect(err).toBeInstanceOf(SafeTxServiceRateLimitError);
      expect((err as SafeTxServiceRateLimitError).url).toContain('/api/v1/safes/');
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — 5xx
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — 5xx', () => {
    it('throws SafeTxServiceApiError on 500', async () => {
      mockFetchOnce(500, {});

      await expect(adapter.getSafeInfo('base', '0xSafe')).rejects.toThrow(SafeTxServiceApiError);
    });

    it('SafeTxServiceApiError carries the status code', async () => {
      mockFetchOnce(503, {});

      const err = await adapter.getSafeInfo('base', '0xSafe').catch((e: Error) => e);
      expect((err as SafeTxServiceApiError).status).toBe(503);
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — AbortSignal
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — AbortSignal', () => {
    it('bubbles abort error when fetch is aborted', async () => {
      const abortError = new DOMException('The operation was aborted.', 'AbortError');
      vi.spyOn(global, 'fetch').mockRejectedValueOnce(abortError);

      await expect(adapter.getSafeInfo('base', '0xSafe')).rejects.toThrow('aborted');
    });
  });

  // -------------------------------------------------------------------------
  // getSafeInfo — no token in logs (Safe TxService is public)
  // -------------------------------------------------------------------------

  describe('getSafeInfo() — no sensitive token in logs', () => {
    it('does not log any bearer/auth token (Safe TxService is public)', async () => {
      // Safe TxService doesn't use auth tokens — this test verifies no token
      // accidentally appears in log output (e.g., from a wrong config read).
      mockFetchOnce(200, makeSafeInfoBody());

      await adapter.getSafeInfo('base', '0xSafe');

      const combined = logMessages.join('\n');
      // Safe service is public — no token should appear
      expect(combined).not.toMatch(/bearer/i);
      expect(combined).not.toMatch(/Authorization/i);
    });
  });

  // -------------------------------------------------------------------------
  // getTransaction — happy path
  // -------------------------------------------------------------------------

  describe('getTransaction() — happy path', () => {
    it('returns executed+successful SafeTxStatus', async () => {
      mockFetchOnce(200, makeTxBody());

      const result = await adapter.getTransaction('base', '0xSafeTxHash');

      expect(result.executed).toBe(true);
      expect(result.isSuccessful).toBe(true);
      expect(result.txHash).toBe('0xOnChainHash');
      expect(result.confirmations).toBe(2);
      expect(result.confirmationsRequired).toBe(2);
    });

    it('returns executed=false when isExecuted is absent', async () => {
      mockFetchOnce(200, {});

      const result = await adapter.getTransaction('base', '0xHash');

      expect(result.executed).toBe(false);
      expect(result.isSuccessful).toBe(false);
      expect(result.txHash).toBeNull();
    });

    it('includes safeTxHash in URL path', async () => {
      const spy = mockFetchOnce(200, makeTxBody());

      await adapter.getTransaction('base', '0xSpecificSafeTxHash');

      const url = (spy.mock.calls[0] as [string, RequestInit])[0];
      expect(url).toContain('/api/v1/multisig-transactions/0xSpecificSafeTxHash/');
    });

    it('confirmations count equals length of confirmations array', async () => {
      mockFetchOnce(200, makeTxBody({ confirmations: [{ owner: '0xA' }, { owner: '0xB' }, { owner: '0xC' }] }));

      const result = await adapter.getTransaction('base', '0xHash');

      expect(result.confirmations).toBe(3);
    });

    it('confirmations defaults to 0 when field absent', async () => {
      mockFetchOnce(200, makeTxBody({ confirmations: undefined }));

      const result = await adapter.getTransaction('base', '0xHash');

      expect(result.confirmations).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // getTransaction — error paths
  // -------------------------------------------------------------------------

  describe('getTransaction() — errors', () => {
    it('throws SafeTxServiceApiError on 404', async () => {
      mockFetchOnce(404, { message: 'Not found' });

      await expect(adapter.getTransaction('base', '0xUnknown')).rejects.toThrow(SafeTxServiceApiError);
    });

    it('retries on 429 and succeeds on second attempt', async () => {
      const origSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(
        (fn: Parameters<typeof setTimeout>[0], _delay?: number, ...args: unknown[]) => {
          return origSetTimeout(fn as (...a: unknown[]) => void, 0, ...args) as unknown as ReturnType<
            typeof setTimeout
          >;
        },
      );

      mockFetchSequence([
        { status: 429, body: {} },
        { status: 200, body: makeTxBody() },
      ]);

      const result = await adapter.getTransaction('base', '0xHash');

      expect(result.executed).toBe(true);
    });

    it('throws SafeTxServiceChainError for non-EVM chain', async () => {
      await expect(adapter.getTransaction('solana', '0xHash')).rejects.toThrow(SafeTxServiceChainError);
    });
  });
});
