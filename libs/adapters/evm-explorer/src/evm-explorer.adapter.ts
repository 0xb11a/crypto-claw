/**
 * EvmExplorerAdapter — HTTP client for Etherscan-compatible `tokentx` endpoints.
 *
 * Supports: Base (Basescan), Ethereum (Etherscan), Arbitrum (Arbiscan),
 * Polygon (Polygonscan), BSC (BscScan), Optimism (Optimistic Etherscan).
 * Chain map is ported from `scripts/chains.js` — bug-for-bug parity (DoD §I).
 *
 * All methods follow ADR-0026: config access uses per-field
 * `configService.get<T>('FIELD')` — never aggregate config objects.
 *
 * Authentication: API key is passed as `?apikey=<value>` query param in the
 * URL (Etherscan v2 convention, no dash unlike Helius). The URL must NEVER
 * be logged in full — `RE_QUERY_APIKEY` in redactor.ts covers `?apikey=...`.
 *
 * Graceful degradation: if the API key env var for a chain is absent, the
 * method throws `EvmExplorerApiKeyMissingError`. The caller (processor) can
 * catch this and count it toward the per-chain fail-fast counter or skip
 * the chain entirely. Boot does NOT fail if explorer keys are missing.
 *
 * Response shape: Etherscan v2 API returns:
 *   `{ status: '1', message: 'OK', result: [...rows] }` on success.
 *   `{ status: '0', message: '...', result: [] | 'Max rate limit reached' }` on failure.
 *
 * SPEC §4 #6 — no `process.env` reads; config injected via ConfigService.
 * SPEC §4 #4 — no signer-key env vars read here.
 * ADR-0026    — per-field config access only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Chain map (ported from scripts/chains.js — bug-for-bug parity DoD §I)
// ---------------------------------------------------------------------------

/**
 * Chain → explorer endpoint configuration.
 *
 * Sourced from `scripts/chains.js` CHAINS[name].explorer. The two EVM chains
 * that currently have an explorer entry are `base` and `ethereum`. All others
 * in the legacy scripts have no `.explorer` field and are therefore not
 * reachable via this adapter.
 *
 * Note: `scripts/activity-wallets-bg.js` uses `getChain(chain).explorer` —
 * if `chain.explorer` is null (Solana, arbitrum, etc.), it would throw. The
 * legacy script routes Solana wallets to `fetchSolanaTxs` instead, so only
 * EVM chains with `.explorer` set ever reach `fetchEvmTokenTxs`. We mirror
 * exactly the chains that have an `explorer` entry in scripts/chains.js.
 */
const CHAIN_EXPLORER_MAP: Record<string, { baseUrl: string; apiKeyEnvVar: string }> = {
  base: {
    baseUrl: 'https://api.basescan.org/api',
    apiKeyEnvVar: 'BASESCAN_API_KEY',
  },
  ethereum: {
    baseUrl: 'https://api.etherscan.io/api',
    apiKeyEnvVar: 'ETHERSCAN_API_KEY',
  },
  // These chains have no entry in scripts/chains.js CHAINS map as of P3g1.
  // They are listed here for completeness (config keys are registered in schema.ts)
  // and will be enabled when those chains are added to scripts/chains.js.
  arbitrum: {
    baseUrl: 'https://api.arbiscan.io/api',
    apiKeyEnvVar: 'ARBISCAN_API_KEY',
  },
  polygon: {
    baseUrl: 'https://api.polygonscan.com/api',
    apiKeyEnvVar: 'POLYGONSCAN_API_KEY',
  },
  bsc: {
    baseUrl: 'https://api.bscscan.com/api',
    apiKeyEnvVar: 'BSCSCAN_API_KEY',
  },
  optimism: {
    baseUrl: 'https://api-optimistic.etherscan.io/api',
    apiKeyEnvVar: 'OPTIMISTIC_ETHERSCAN_API_KEY',
  },
};

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when the API key env var for a chain is absent from the runtime config.
 *
 * The keys are optional — chains without keys are skipped at the processor
 * level (the per-chain fail-fast counter handles repeated misses).
 */
export class EvmExplorerApiKeyMissingError extends Error {
  constructor(
    public readonly chain: string,
    public readonly envVar: string,
  ) {
    super(`${envVar} is not configured — EVM explorer calls for chain '${chain}' are unavailable`);
    this.name = 'EvmExplorerApiKeyMissingError';
  }
}

/**
 * Thrown when the chain name is not in the supported explorer map.
 */
export class EvmExplorerUnsupportedChainError extends Error {
  constructor(public readonly chain: string) {
    super(`Chain '${chain}' has no Etherscan-compatible explorer configured in EvmExplorerAdapter`);
    this.name = 'EvmExplorerUnsupportedChainError';
  }
}

/**
 * Thrown when the Etherscan-compatible API returns a non-2xx HTTP status.
 */
export class EvmExplorerApiError extends Error {
  constructor(
    /** Redacted URL (apikey stripped) — safe to include in logs. */
    public readonly redactedUrl: string,
    public readonly status: number,
  ) {
    super(`EVM explorer API error: HTTP ${status} from ${redactedUrl}`);
    this.name = 'EvmExplorerApiError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/**
 * A single ERC-20 token transfer row from the Etherscan `tokentx` API.
 *
 * Field names match the Etherscan v2 API response shape exactly so that
 * `extractEvmSwaps()` can consume this type without an intermediate mapping.
 * This mirrors the legacy usage in `scripts/activity-wallets-bg.js`.
 */
export interface EvmTokenTxRow {
  /** Transaction hash (0x-prefixed hex). */
  hash: string;
  /** Sender address (0x-prefixed hex). */
  from: string;
  /** Recipient address (0x-prefixed hex). */
  to: string;
  /** ERC-20 contract address (0x-prefixed hex). */
  contractAddress: string;
  /** Token symbol (e.g. 'USDC'). */
  tokenSymbol: string;
  /** Token name (e.g. 'USD Coin'). */
  tokenName: string;
  /** Transfer amount in smallest unit (wei-like string). */
  value: string;
  /** Unix timestamp string (decimal seconds since epoch). */
  timeStamp: string;
  /** Allow additional fields from Etherscan without type errors. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Number of most-recent token transfers to fetch per wallet. Mirrors legacy TOKENTX_OFFSET = 50. */
const TOKENTX_OFFSET = 50;

/**
 * NestJS injectable adapter for Etherscan-compatible EVM explorer APIs.
 *
 * Inject in modules via `EvmExplorerModule.imports` → provider registration.
 * The module and barrel re-export this class; no direct instantiation.
 */
@Injectable()
export class EvmExplorerAdapter {
  private readonly logger = new Logger(EvmExplorerAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolve the explorer config for a given chain.
   *
   * @throws {EvmExplorerUnsupportedChainError} if `chain` has no explorer map entry.
   */
  private getChainConfig(chain: string): { baseUrl: string; apiKeyEnvVar: string } {
    const config = CHAIN_EXPLORER_MAP[chain];
    if (!config) throw new EvmExplorerUnsupportedChainError(chain);
    return config;
  }

  /**
   * Resolve and validate the API key for a given chain from config.
   *
   * Called lazily so that boot does not fail when keys are absent.
   * ADR-0026: per-field get, not aggregate config fetch.
   *
   * @throws {EvmExplorerApiKeyMissingError} if the key env var is absent.
   */
  private getApiKey(chain: string, envVar: string): string {
    const key = this.configService.get<string>(envVar);
    if (!key) throw new EvmExplorerApiKeyMissingError(chain, envVar);
    return key;
  }

  /**
   * Build a redacted form of the URL safe for logging.
   *
   * Replaces the `apikey` query param value with `[REDACTED]`.
   * Defence-in-depth on top of `RE_QUERY_APIKEY` in redactor.ts.
   */
  private redactUrl(rawUrl: string): string {
    return rawUrl.replace(/([?&]apikey=)[^&\s]*/gi, '$1[REDACTED]');
  }

  /**
   * Fetch recent ERC-20 token transfers for a wallet address from an
   * Etherscan-compatible explorer.
   *
   * Returns `null` when the chain is unsupported.
   * Returns an empty array when the explorer returns no transfers.
   *
   * Mirrors `fetchEvmTokenTxs()` in `scripts/activity-wallets-bg.js`:
   *   - Uses `module=account&action=tokentx` Etherscan v2 API.
   *   - `page=1&offset=50&sort=desc` — 50 most recent, descending.
   *   - Returns `[]` on non-`status=1` response (API error / no txs).
   *
   * @param address - EVM wallet address (0x-prefixed hex).
   * @param chain - Chain identifier (e.g. 'base', 'ethereum').
   * @param opts.signal - Optional AbortSignal for wall-clock cap.
   *
   * @throws {EvmExplorerApiKeyMissingError} if the API key env var is absent.
   * @throws {EvmExplorerApiError} if the API returns a non-2xx HTTP status.
   * @throws Any `fetch` error (network, timeout from AbortSignal) propagates as-is.
   */
  async getTokenTx(
    address: string,
    chain: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<EvmTokenTxRow[] | null> {
    const { signal } = opts;

    let chainConfig: { baseUrl: string; apiKeyEnvVar: string };
    try {
      chainConfig = this.getChainConfig(chain);
    } catch (err) {
      if (err instanceof EvmExplorerUnsupportedChainError) {
        this.logger.debug(`evm-explorer.getTokenTx: unsupported chain '${chain}' — skipping`);
        return null;
      }
      throw err;
    }

    const apiKey = this.getApiKey(chain, chainConfig.apiKeyEnvVar);

    // Build URL — mirrors scripts/activity-wallets-bg.js:fetchEvmTokenTxs exactly.
    const rawUrl =
      `${chainConfig.baseUrl}?module=account&action=tokentx` +
      `&address=${address}&page=1&offset=${TOKENTX_OFFSET}&sort=desc&apikey=${apiKey}`;
    const redactedUrl = this.redactUrl(rawUrl);

    this.logger.debug(`evm-explorer.getTokenTx: fetching tokentx for ${address} on ${chain} url=${redactedUrl}`);

    const response = await fetch(rawUrl, { signal });

    if (!response.ok) {
      throw new EvmExplorerApiError(redactedUrl, response.status);
    }

    const data = (await response.json()) as { status?: string; result?: unknown };

    // Etherscan returns status='1' + Array result on success; everything else is treated
    // as empty (no transfers) — mirrors scripts/activity-wallets-bg.js:64-65.
    if (data.status !== '1' || !Array.isArray(data.result)) {
      return [];
    }

    return data.result as EvmTokenTxRow[];
  }

  /**
   * Check whether a chain identifier has a supported Etherscan-compatible explorer.
   *
   * Used by the processor to skip unknown chains before attempting a fetch.
   */
  static supportsChain(chain: string): boolean {
    return chain in CHAIN_EXPLORER_MAP;
  }
}
