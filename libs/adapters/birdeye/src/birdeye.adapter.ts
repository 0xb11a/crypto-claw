/**
 * BirdeyeAdapter — HTTP client for the Birdeye API.
 *
 * All methods follow ADR-0026: config access uses per-field
 * `configService.get<T>('FIELD')` — never aggregate config objects.
 *
 * Authentication: `X-API-KEY` request header. The header value is read
 * from the `BIRDEYE_API_KEY` env var via ConfigService. If the key is
 * absent, methods throw {@link BirdeyeApiKeyMissingError}.
 *
 * Rate limiting: Birdeye returns HTTP 429 for quota violations. The
 * adapter throws {@link BirdeyeRateLimitError} on 429 so callers can
 * decide whether to back off, skip, or bubble up the error.
 *
 * Cancellation: every method accepts an optional `AbortSignal` for
 * per-call wall-clock caps. Pass `AbortSignal.timeout(ms)` for a simple
 * deadline without maintaining an AbortController reference.
 *
 * SPEC §4 #6 — no `process.env` reads; config injected via ConfigService.
 * SPEC §4 #4 — no signer-key env vars read here.
 * ADR-0026    — per-field config access only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/**
 * Thrown when `BIRDEYE_API_KEY` is absent from the runtime config.
 *
 * The schema marks the key optional (wallet-pipeline is skipped when the
 * key is absent), so this error is thrown lazily (on first call) rather
 * than at boot time.
 */
export class BirdeyeApiKeyMissingError extends Error {
  constructor() {
    super('BIRDEYE_API_KEY is not configured — Birdeye calls are unavailable');
    this.name = 'BirdeyeApiKeyMissingError';
  }
}

/**
 * Thrown when Birdeye returns HTTP 429 (Too Many Requests).
 *
 * Processors that catch this error should add the wallet/token to the
 * failed queue (retry_count++) rather than throwing immediately, so a
 * single rate-limit event doesn't halt the whole cycle.
 */
export class BirdeyeRateLimitError extends Error {
  constructor(public readonly url: string) {
    super(`Birdeye API rate limit (429) hit: ${url}`);
    this.name = 'BirdeyeRateLimitError';
  }
}

/**
 * Thrown when Birdeye returns an unexpected non-2xx, non-429 HTTP status.
 */
export class BirdeyeApiError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`Birdeye API error: HTTP ${status} from ${url}`);
    this.name = 'BirdeyeApiError';
  }
}

/**
 * Stub error for methods not yet implemented in PR-A.
 *
 * PR-B will replace this with real implementations for `getTraderRank`
 * and `getTokenTopTraders`. Stubs are thrown rather than left as empty
 * bodies so TypeScript enforces return-type correctness at compile time.
 */
export class NotImplementedError extends Error {
  constructor(method: string) {
    super(`BirdeyeAdapter.${method} is not implemented in PR-A — ships in PR-B`);
    this.name = 'NotImplementedError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/**
 * One entry from the top-gainers list.
 *
 * Normalised to a flat shape so the harvest processor does not depend on
 * Birdeye's raw response envelope.
 */
export interface TopGainerEntry {
  /** Token contract address (checksummed EVM or base58 Solana). */
  address: string;
  /** Chain identifier matching the ACTIVE_CHAINS config values. */
  chain: string;
  /** Token symbol as returned by Birdeye (e.g. "SOL", "USDC"). */
  symbol: string;
}

/**
 * Stub type for getTraderRank — return type reserved for PR-B.
 *
 * @deprecated Do not use — throws NotImplementedError in PR-A.
 */
export interface TraderRankResult {
  rank: number;
  winRate: number;
  pnl30d: number;
}

/**
 * Stub type for getTokenTopTraders — return type reserved for PR-B.
 *
 * @deprecated Do not use — throws NotImplementedError in PR-A.
 */
export interface TokenTopTrader {
  address: string;
  volume: number;
  pnl: number;
}

// ---------------------------------------------------------------------------
// Birdeye chain identifiers
// ---------------------------------------------------------------------------

/**
 * Maps ACTIVE_CHAINS values to Birdeye's `chain` query parameter.
 *
 * Birdeye uses different chain identifiers from the internal ACTIVE_CHAINS
 * config values. Unknown chains are passed through as-is (Birdeye may add
 * new chains in the future without a code change).
 */
const CHAIN_ID_MAP: Record<string, string> = {
  solana: 'solana',
  base: 'base',
  ethereum: 'ethereum',
  arbitrum: 'arbitrum',
  polygon: 'polygon',
  bsc: 'bsc',
  optimism: 'optimism',
};

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Base URL for the Birdeye public API. */
const BIRDEYE_BASE_URL = 'https://public-api.birdeye.so';

/**
 * NestJS injectable adapter for the Birdeye REST API.
 *
 * Inject in modules via `BirdeyeModule.imports` → provider registration.
 * The module and barrel re-export this class; no direct instantiation.
 */
@Injectable()
export class BirdeyeAdapter {
  private readonly logger = new Logger(BirdeyeAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolve and validate the Birdeye API key from config.
   *
   * Called lazily (not in constructor) so that boot does not fail when
   * the key is absent and the caller handles the `BirdeyeApiKeyMissingError`.
   *
   * ADR-0026: per-field get, not aggregate config fetch.
   */
  private getApiKey(): string {
    const key = this.configService.get<string>('BIRDEYE_API_KEY');
    if (!key) throw new BirdeyeApiKeyMissingError();
    return key;
  }

  /**
   * Perform a Birdeye HTTP GET with standard headers.
   *
   * Throws:
   * - `BirdeyeRateLimitError` on HTTP 429.
   * - `BirdeyeApiError` on other non-2xx responses.
   * - Any `fetch` error (network, timeout from AbortSignal) propagates as-is.
   *
   * The `X-API-KEY` header value is sourced from the `BIRDEYE_API_KEY` env
   * var. It is not logged anywhere in this method — the caller's debug
   * level should log the URL only, never the key.
   */
  private async fetchBirdeye<T>(url: string, signal?: AbortSignal): Promise<T> {
    const apiKey = this.getApiKey();
    // NOTE: `X-API-KEY` header value is never logged — logger redaction in
    // libs/logger covers the header pattern, but the value is intentionally
    // not passed to logger.debug here as an extra defence layer.
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'X-API-KEY': apiKey,
        Accept: 'application/json',
      },
      signal,
    });

    if (response.status === 429) {
      throw new BirdeyeRateLimitError(url);
    }

    if (!response.ok) {
      throw new BirdeyeApiError(url, response.status);
    }

    return response.json() as Promise<T>;
  }

  /**
   * Fetch top gainers for the given chains from Birdeye.
   *
   * Queries the Birdeye `/defi/token_trending` endpoint for each chain in
   * parallel (one request per chain). Partial failures (one chain's request
   * throws) are caught and logged — the method returns results for chains
   * that succeeded. A complete failure (all chains throw) propagates the
   * last error.
   *
   * @param chains - ACTIVE_CHAINS values to query (e.g. ['base', 'solana']).
   * @param opts.signal - Optional AbortSignal for wall-clock cap. Use
   *   `AbortSignal.timeout(ms)` for a simple deadline.
   * @returns Flat array of top-gainer entries across all queried chains.
   *
   * @throws {BirdeyeApiKeyMissingError} if BIRDEYE_API_KEY is not set.
   * @throws {BirdeyeRateLimitError} if any chain request returns 429 (re-thrown
   *   after the other chains have resolved — worst case: one per chain).
   */
  async getTopGainersPerChain(chains: string[], opts: { signal?: AbortSignal } = {}): Promise<TopGainerEntry[]> {
    const { signal } = opts;
    const results: TopGainerEntry[] = [];
    const errors: Error[] = [];

    const settled = await Promise.allSettled(
      chains.map(async (chain) => {
        const birdeyeChain = CHAIN_ID_MAP[chain] ?? chain;
        // Birdeye trending endpoint: returns a list of trending tokens for the chain.
        // sort_by=price_change_24h_percent, sort_type=desc → top gainers in last 24h.
        const url =
          `${BIRDEYE_BASE_URL}/defi/token_trending` +
          `?chain=${encodeURIComponent(birdeyeChain)}` +
          `&sort_by=price_change_24h_percent&sort_type=desc&offset=0&limit=20`;

        this.logger.debug(`birdeye.getTopGainersPerChain: fetching chain=${chain}`);

        const data = await this.fetchBirdeye<{
          data?: { items?: Array<{ address?: string; symbol?: string }> };
        }>(url, signal);

        const items = data?.data?.items ?? [];
        return items
          .filter((item) => item.address)
          .map(
            (item): TopGainerEntry => ({
              address: item.address ?? '',
              chain,
              symbol: item.symbol ?? '',
            }),
          );
      }),
    );

    for (let i = 0; i < settled.length; i++) {
      const outcome = settled[i];
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value);
      } else {
        const err = outcome.reason as Error;
        this.logger.warn(`birdeye.getTopGainersPerChain: chain=${chains[i]} failed: ${err.message}`);
        errors.push(err);
      }
    }

    if (results.length === 0 && errors.length > 0) {
      // All chains failed — re-throw the first error so BullMQ can retry.
      throw errors[0];
    }

    return results;
  }

  /**
   * Get the trader rank and performance metrics for a wallet address.
   *
   * @throws {NotImplementedError} Always — ships in PR-B.
   * @deprecated Not available in PR-A. Use after PR-B lands.
   */
  async getTraderRank(_address: string, _chain: string): Promise<TraderRankResult> {
    throw new NotImplementedError('getTraderRank');
  }

  /**
   * Get the top traders for a token address.
   *
   * @throws {NotImplementedError} Always — ships in PR-B.
   * @deprecated Not available in PR-A. Use after PR-B lands.
   */
  async getTokenTopTraders(_tokenAddress: string, _chain: string): Promise<TokenTopTrader[]> {
    throw new NotImplementedError('getTokenTopTraders');
  }
}
