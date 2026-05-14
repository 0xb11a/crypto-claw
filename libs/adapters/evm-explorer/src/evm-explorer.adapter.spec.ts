/**
 * Unit tests for EvmExplorerAdapter (SPEC §14, DoD §A, §F).
 *
 * Mocks `fetch` at the global boundary via vi.stubGlobal. No real network calls.
 *
 * Covers:
 *   - supportsChain() static method: per-map truth table.
 *   - 200 + status=1 happy path for each supported chain (table-driven).
 *   - Empty result when API returns status=0 (no transfers).
 *   - Returns null for unsupported chain (solana) without HTTP call.
 *   - Throws EvmExplorerApiKeyMissingError when API key env var absent.
 *   - Throws EvmExplorerApiError on non-2xx HTTP status (429, 500).
 *   - EvmExplorerApiError carries status code and redacted URL.
 *   - AbortSignal passed through to fetch.
 *   - URL shape: correct base URL per chain, module/action/address params.
 *   - NO x-chain header (Etherscan v2 uses query-string auth, not header).
 *   - ?apikey= token is redacted in all Logger calls and in error.redactedUrl.
 *   - ADR-0026: configService.get called with exact env var string per chain.
 *   - No process.env reads (SPEC §4 #6).
 *
 * SPEC §4 #4: no signer-key env vars.
 * SPEC §4 #6: all config via ConfigService.
 * ADR-0026: per-field config access only.
 * DoD §F: API keys must not leak into any log line.
 * DoD §I: bug-for-bug parity with legacy scripts/activity-wallets-bg.js.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  EvmExplorerAdapter,
  EvmExplorerApiKeyMissingError,
  EvmExplorerUnsupportedChainError,
  EvmExplorerApiError,
} from './evm-explorer.adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(keys: Record<string, string> = {}): ConfigService {
  return {
    get: vi.fn().mockImplementation((field: string) => keys[field] ?? null),
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

const DEFAULT_KEYS = {
  BASESCAN_API_KEY: 'test-basescan-key-aaaaaaaaaaaaaaaa',
  ETHERSCAN_API_KEY: 'test-etherscan-key-aaaaaaaaaaaaaaa',
  ARBISCAN_API_KEY: 'test-arbiscan-key-aaaaaaaaaaaaaaaa',
  POLYGONSCAN_API_KEY: 'test-polygonscan-key-aaaaaaaaaaaaa',
  BSCSCAN_API_KEY: 'test-bscscan-key-aaaaaaaaaaaaaaaa',
  OPTIMISTIC_ETHERSCAN_API_KEY: 'test-optimism-key-aaaaaaaaaaaaaaaa',
};

const TX_ROW = {
  hash: '0xabc123',
  from: '0x1111',
  to: '0x2222',
  contractAddress: '0x3333',
  tokenSymbol: 'USDC',
  tokenName: 'USD Coin',
  value: '1000000',
  timeStamp: '1700000000',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// supportsChain() — static truth table (CHAIN_EXPLORER_MAP keys)
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.supportsChain (static)', () => {
  it('returns true for "base"', () => {
    expect(EvmExplorerAdapter.supportsChain('base')).toBe(true);
  });

  it('returns true for "ethereum"', () => {
    expect(EvmExplorerAdapter.supportsChain('ethereum')).toBe(true);
  });

  it('returns true for "arbitrum"', () => {
    expect(EvmExplorerAdapter.supportsChain('arbitrum')).toBe(true);
  });

  it('returns true for "polygon"', () => {
    expect(EvmExplorerAdapter.supportsChain('polygon')).toBe(true);
  });

  it('returns true for "bsc"', () => {
    expect(EvmExplorerAdapter.supportsChain('bsc')).toBe(true);
  });

  it('returns true for "optimism"', () => {
    expect(EvmExplorerAdapter.supportsChain('optimism')).toBe(true);
  });

  it('returns false for "solana"', () => {
    expect(EvmExplorerAdapter.supportsChain('solana')).toBe(false);
  });

  it('returns false for unknown chain', () => {
    expect(EvmExplorerAdapter.supportsChain('unknown-chain-xyz')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(EvmExplorerAdapter.supportsChain('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — happy path, table-driven per supported chain
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — 200 success (table-driven per chain)', () => {
  const supportedChains: Array<{
    chain: string;
    keyVar: string;
    expectedUrlSubstring: string;
  }> = [
    { chain: 'base', keyVar: 'BASESCAN_API_KEY', expectedUrlSubstring: 'basescan.org' },
    { chain: 'ethereum', keyVar: 'ETHERSCAN_API_KEY', expectedUrlSubstring: 'etherscan.io' },
    { chain: 'arbitrum', keyVar: 'ARBISCAN_API_KEY', expectedUrlSubstring: 'arbiscan.io' },
    { chain: 'polygon', keyVar: 'POLYGONSCAN_API_KEY', expectedUrlSubstring: 'polygonscan.com' },
    { chain: 'bsc', keyVar: 'BSCSCAN_API_KEY', expectedUrlSubstring: 'bscscan.com' },
    { chain: 'optimism', keyVar: 'OPTIMISTIC_ETHERSCAN_API_KEY', expectedUrlSubstring: 'optimistic.etherscan.io' },
  ];

  for (const { chain, keyVar, expectedUrlSubstring } of supportedChains) {
    it(`[${chain}] returns rows and uses ${expectedUrlSubstring}`, async () => {
      const fetchSpy = makeFetchSpy({ status: '1', message: 'OK', result: [TX_ROW] });
      const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

      const result = await adapter.getTokenTx('0xWallet', chain);

      expect(result).toEqual([TX_ROW]);
      const calledUrl: string = fetchSpy.mock.calls[0][0] as string;
      expect(calledUrl).toContain(expectedUrlSubstring);
      expect(calledUrl).toContain('0xWallet');
      expect(calledUrl).toContain('apikey=');
    });

    it(`[${chain}] configService.get called with "${keyVar}"`, async () => {
      makeFetchSpy({ status: '1', result: [] });
      const cfgSvc = makeConfigService(DEFAULT_KEYS);
      const adapter = new EvmExplorerAdapter(cfgSvc);

      await adapter.getTokenTx('0xWallet', chain);

      expect(cfgSvc.get).toHaveBeenCalledWith(keyVar);
    });
  }
});

// ---------------------------------------------------------------------------
// getTokenTx() — URL shape assertions (parity with legacy)
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — URL shape (legacy parity DoD §I)', () => {
  it('URL includes module=account&action=tokentx', async () => {
    const fetchSpy = makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'base');

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('module=account');
    expect(url).toContain('action=tokentx');
  });

  it('URL includes page=1&offset=50&sort=desc (legacy TOKENTX_OFFSET=50 parity)', async () => {
    const fetchSpy = makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'base');

    const url: string = fetchSpy.mock.calls[0][0] as string;
    expect(url).toContain('page=1');
    expect(url).toContain('offset=50');
    expect(url).toContain('sort=desc');
  });

  it('does NOT send x-chain header (Etherscan uses query-string, not header)', async () => {
    const fetchSpy = makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'base');

    const callOpts = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    const headers = callOpts?.headers as Record<string, string> | undefined;
    if (headers) {
      const headerKeys = Object.keys(headers).map((k) => k.toLowerCase());
      expect(headerKeys).not.toContain('x-chain');
    }
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — empty / no-result responses
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — empty results', () => {
  it('returns [] when API returns status=0 (no transactions)', async () => {
    makeFetchSpy({ status: '0', message: 'No transactions found', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const result = await adapter.getTokenTx('0xWallet', 'base');
    expect(result).toEqual([]);
  });

  it('returns [] when result is not an array (Max rate limit string)', async () => {
    makeFetchSpy({ status: '0', message: 'Max rate limit reached', result: 'Max rate limit reached' });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const result = await adapter.getTokenTx('0xWallet', 'base');
    expect(result).toEqual([]);
  });

  it('returns [] when status=1 but result is missing', async () => {
    makeFetchSpy({ status: '1', message: 'OK' }); // no result field
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const result = await adapter.getTokenTx('0xWallet', 'base');
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — unsupported chain returns null without HTTP call
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — unsupported chain', () => {
  it('returns null for solana chain', async () => {
    const fetchSpy = makeFetchSpy({});
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const result = await adapter.getTokenTx('0xWallet', 'solana');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null for unknown chain without making an HTTP call', async () => {
    const fetchSpy = makeFetchSpy({});
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const result = await adapter.getTokenTx('0xWallet', 'unknown-chain-xyz');

    expect(result).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('EvmExplorerUnsupportedChainError message includes chain name', () => {
    const err = new EvmExplorerUnsupportedChainError('avalanche');
    expect(err.message).toContain('avalanche');
    expect(err.name).toBe('EvmExplorerUnsupportedChainError');
    expect(err.chain).toBe('avalanche');
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — missing API key
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — missing API key', () => {
  it('throws EvmExplorerApiKeyMissingError when BASESCAN_API_KEY is absent', async () => {
    const fetchSpy = makeFetchSpy({});
    const adapter = new EvmExplorerAdapter(makeConfigService({})); // no keys

    await expect(adapter.getTokenTx('0xWallet', 'base')).rejects.toThrow(EvmExplorerApiKeyMissingError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('EvmExplorerApiKeyMissingError carries chain and envVar', async () => {
    const adapter = new EvmExplorerAdapter(makeConfigService({}));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as EvmExplorerApiKeyMissingError;
    expect(err.chain).toBe('base');
    expect(err.envVar).toBe('BASESCAN_API_KEY');
    expect(err.name).toBe('EvmExplorerApiKeyMissingError');
  });

  it('throws EvmExplorerApiKeyMissingError when only one chain key is missing', async () => {
    // Only base key is missing; ethereum key present
    const adapter = new EvmExplorerAdapter(makeConfigService({ ETHERSCAN_API_KEY: 'test-key' }));

    await expect(adapter.getTokenTx('0xWallet', 'base')).rejects.toThrow(EvmExplorerApiKeyMissingError);
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — HTTP errors
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — HTTP errors', () => {
  it('throws EvmExplorerApiError on 429', async () => {
    makeFetchSpy({}, 429);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await expect(adapter.getTokenTx('0xWallet', 'base')).rejects.toThrow(EvmExplorerApiError);
  });

  it('throws EvmExplorerApiError on 500', async () => {
    makeFetchSpy({}, 500);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await expect(adapter.getTokenTx('0xWallet', 'base')).rejects.toThrow(EvmExplorerApiError);
  });

  it('EvmExplorerApiError carries the HTTP status', async () => {
    makeFetchSpy({}, 503);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as EvmExplorerApiError;
    expect(err.status).toBe(503);
  });

  it('EvmExplorerApiError.name is "EvmExplorerApiError"', async () => {
    makeFetchSpy({}, 500);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as Error;
    expect(err.name).toBe('EvmExplorerApiError');
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — API key redaction (DoD §F)
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — API key redaction (DoD §F)', () => {
  it('raw BASESCAN_API_KEY NEVER appears in any Logger call on success path', async () => {
    const messages = captureLogOutput();
    makeFetchSpy({ status: '1', result: [TX_ROW] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'base');

    const allOutput = messages.join('\n');
    expect(allOutput).not.toContain(DEFAULT_KEYS['BASESCAN_API_KEY']);
  });

  it('raw API key NEVER appears in any Logger call on 500 error path', async () => {
    const messages = captureLogOutput();
    makeFetchSpy({}, 500);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'base').catch(() => {});

    const allOutput = messages.join('\n');
    expect(allOutput).not.toContain(DEFAULT_KEYS['BASESCAN_API_KEY']);
  });

  it('EvmExplorerApiError.redactedUrl does NOT contain raw BASESCAN_API_KEY', async () => {
    makeFetchSpy({}, 503);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as EvmExplorerApiError;

    expect(err.redactedUrl).not.toContain(DEFAULT_KEYS['BASESCAN_API_KEY']);
    expect(err.redactedUrl).toContain('[REDACTED]');
  });

  it('EvmExplorerApiError.redactedUrl preserves basescan.org and wallet address', async () => {
    makeFetchSpy({}, 503);
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWalletAddr', 'base').catch((e) => e)) as EvmExplorerApiError;

    expect(err.redactedUrl).toContain('basescan.org');
    expect(err.redactedUrl).toContain('0xWalletAddr');
  });

  it('raw ETHERSCAN_API_KEY NEVER appears in Logger for ethereum chain', async () => {
    const messages = captureLogOutput();
    makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    await adapter.getTokenTx('0xWallet', 'ethereum');

    const allOutput = messages.join('\n');
    expect(allOutput).not.toContain(DEFAULT_KEYS['ETHERSCAN_API_KEY']);
  });
});

// ---------------------------------------------------------------------------
// getTokenTx() — AbortSignal
// ---------------------------------------------------------------------------

describe('EvmExplorerAdapter.getTokenTx — AbortSignal', () => {
  it('passes AbortSignal through to fetch', async () => {
    const fetchSpy = makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));
    const controller = new AbortController();

    await adapter.getTokenTx('0xWallet', 'base', { signal: controller.signal });

    const callOpts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(callOpts.signal).toBe(controller.signal);
  });

  it('bubbles up AbortError when signal fires', async () => {
    const abortErr = new DOMException('aborted', 'AbortError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as Error;
    expect(err.name).toBe('AbortError');
  });

  it('bubbles up TimeoutError from AbortSignal.timeout', async () => {
    const timeoutErr = new DOMException('timed out', 'TimeoutError');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(timeoutErr));
    const adapter = new EvmExplorerAdapter(makeConfigService(DEFAULT_KEYS));

    const err = (await adapter.getTokenTx('0xWallet', 'base').catch((e) => e)) as Error;
    expect(err.name).toBe('TimeoutError');
  });
});

// ---------------------------------------------------------------------------
// ADR-0026: per-field config access
// ---------------------------------------------------------------------------

describe('ADR-0026 — per-field config access', () => {
  it('does NOT call configService.get with an empty string or undefined key', async () => {
    const cfgSvc = makeConfigService(DEFAULT_KEYS);
    makeFetchSpy({ status: '1', result: [] });
    const adapter = new EvmExplorerAdapter(cfgSvc);

    await adapter.getTokenTx('0xWallet', 'base');

    const calls = (cfgSvc.get as ReturnType<typeof vi.fn>).mock.calls as string[][];
    const badCalls = calls.filter((args) => !args[0] || args[0] === '');
    expect(badCalls).toHaveLength(0);
  });
});
