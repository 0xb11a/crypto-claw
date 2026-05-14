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
 * Result from the Birdeye gainers-losers leaderboard check for a wallet.
 *
 * Mirrors the return shape of `fetchBirdeyeTraderRank` in
 * `scripts/score-wallet.js` (DoD §I — bug-for-bug parity).
 */
export type TraderRankResult =
  | {
      source: 'birdeye_trader';
      inTopGainers: true;
      /** 1-based rank in the leaderboard response. */
      rank: number;
      /** Today's PnL in USD. */
      pnl: number;
      /** Today's volume in USD. */
      volume: number;
      /** Number of trades today. */
      tradeCount: number;
      /** Total items in the leaderboard response. */
      totalTraders: number;
    }
  | {
      source: 'birdeye_trader';
      inTopGainers: false;
      rank: null;
      /** Median PnL of the leaderboard (context for scoring). */
      medianPnl: number;
      /** Top PnL of the leaderboard (context for scoring). */
      topPnl: number;
    };

/**
 * One entry from the Birdeye token top-traders endpoint.
 *
 * Mirrors the return shape of `fetchBirdeyeTokenTraderStats` in
 * `scripts/score-wallet.js` (DoD §I — bug-for-bug parity).
 */
export type TokenTopTrader =
  | {
      isTopTrader: true;
      /** 1-based rank in the top-traders list for this token. */
      rank: number;
      volume: number;
      trades: number;
      buys: number;
      sells: number;
      volumeBuy: number;
      volumeSell: number;
    }
  | {
      isTopTrader: false;
    };

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
   *
   * @param url - Full URL to request.
   * @param signal - Optional AbortSignal.
   * @param birdeyeChain - Optional `x-chain` header value (required by some endpoints).
   */
  private async fetchBirdeye<T>(url: string, signal?: AbortSignal, birdeyeChain?: string): Promise<T> {
    const apiKey = this.getApiKey();
    // NOTE: `X-API-KEY` header value is never logged — logger redaction in
    // libs/logger covers the header pattern, but the value is intentionally
    // not passed to logger.debug here as an extra defence layer.
    const headers: Record<string, string> = {
      'X-API-KEY': apiKey,
      Accept: 'application/json',
    };
    if (birdeyeChain) {
      headers['x-chain'] = birdeyeChain;
    }

    const response = await fetch(url, {
      method: 'GET',
      headers,
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
   * Check whether a wallet address appears in the Birdeye daily gainers-losers
   * leaderboard for the given chain.
   *
   * Calls `/trader/gainers-losers?type=today&sort_by=PnL&sort_type=desc&limit=10`
   * with the `x-chain` header. Mirrors `fetchBirdeyeTraderRank` in
   * `scripts/score-wallet.js` (DoD §I — bug-for-bug parity).
   *
   * Returns `null` when:
   * - `chain` is not in `CHAIN_ID_MAP` (unsupported chain)
   * - The API returns an unexpected shape
   *
   * @param address - Wallet address to look up (case-insensitive match).
   * @param chain - ACTIVE_CHAINS chain identifier (e.g. 'base', 'solana').
   * @param opts.signal - Optional AbortSignal for wall-clock cap.
   *
   * @throws {BirdeyeApiKeyMissingError} if BIRDEYE_API_KEY is not configured.
   * @throws {BirdeyeRateLimitError} on HTTP 429.
   * @throws {BirdeyeApiError} on other non-2xx responses.
   */
  async getTraderRank(
    address: string,
    chain: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TraderRankResult | null> {
    const { signal } = opts;
    const birdeyeChain = CHAIN_ID_MAP[chain];
    if (!birdeyeChain) {
      this.logger.debug(`birdeye.getTraderRank: unsupported chain=${chain} for ${address}`);
      return null;
    }

    const url = `${BIRDEYE_BASE_URL}/trader/gainers-losers` + `?type=today&sort_by=PnL&sort_type=desc&limit=10`;

    this.logger.debug(`birdeye.getTraderRank: checking leaderboard for ${address} chain=${chain}`);

    const data = await this.fetchBirdeye<{
      success?: boolean;
      data?: {
        items?: Array<{
          address?: string;
          pnl?: number;
          volume?: number;
          trade_count?: number;
        }>;
      };
    }>(url, signal, birdeyeChain);

    if (!data.success || !data.data?.items) {
      return null;
    }

    const items = data.data.items;
    const addrLower = address.toLowerCase();
    const matchIndex = items.findIndex((t) => t.address?.toLowerCase() === addrLower);

    if (matchIndex >= 0) {
      const match = items[matchIndex];
      return {
        source: 'birdeye_trader',
        inTopGainers: true,
        rank: matchIndex + 1,
        pnl: match.pnl ?? 0,
        volume: match.volume ?? 0,
        tradeCount: match.trade_count ?? 0,
        totalTraders: items.length,
      };
    }

    const medianIdx = Math.floor(items.length / 2);
    return {
      source: 'birdeye_trader',
      inTopGainers: false,
      rank: null,
      medianPnl: items[medianIdx]?.pnl ?? 0,
      topPnl: items[0]?.pnl ?? 0,
    };
  }

  /**
   * Check whether a wallet address appears in the top traders for a given token.
   *
   * Calls `/defi/v2/tokens/top_traders?address=TOKEN&sort_by=volume&sort_type=desc&limit=50`
   * with the `x-chain` header. Mirrors `fetchBirdeyeTokenTraderStats` in
   * `scripts/score-wallet.js` (DoD §I — bug-for-bug parity).
   *
   * Returns `null` when `tokenAddress` is absent or `chain` is unsupported.
   *
   * @param walletAddress - Wallet address to look up (case-insensitive match).
   * @param tokenAddress - Token contract address to query top traders for.
   * @param chain - ACTIVE_CHAINS chain identifier.
   * @param opts.signal - Optional AbortSignal for wall-clock cap.
   *
   * @throws {BirdeyeApiKeyMissingError} if BIRDEYE_API_KEY is not configured.
   * @throws {BirdeyeRateLimitError} on HTTP 429.
   * @throws {BirdeyeApiError} on other non-2xx responses.
   */
  async getTokenTopTraders(
    walletAddress: string,
    tokenAddress: string,
    chain: string,
    opts: { signal?: AbortSignal } = {},
  ): Promise<TokenTopTrader | null> {
    const { signal } = opts;

    if (!tokenAddress) {
      return null;
    }

    const birdeyeChain = CHAIN_ID_MAP[chain];
    if (!birdeyeChain) {
      this.logger.debug(`birdeye.getTokenTopTraders: unsupported chain=${chain}`);
      return null;
    }

    const url =
      `${BIRDEYE_BASE_URL}/defi/v2/tokens/top_traders` +
      `?address=${encodeURIComponent(tokenAddress)}&sort_by=volume&sort_type=desc&limit=50`;

    this.logger.debug(`birdeye.getTokenTopTraders: checking top traders for token=${tokenAddress} chain=${chain}`);

    const data = await this.fetchBirdeye<{
      success?: boolean;
      data?: {
        items?: Array<{
          owner?: string;
          volume?: number;
          trade?: number;
          tradeBuy?: number;
          tradeSell?: number;
          volumeBuy?: number;
          volumeSell?: number;
        }>;
      };
    }>(url, signal, birdeyeChain);

    if (!data.success || !data.data?.items) {
      return null;
    }

    const items = data.data.items;
    const addrLower = walletAddress.toLowerCase();
    const matchIndex = items.findIndex((t) => t.owner?.toLowerCase() === addrLower);

    if (matchIndex >= 0) {
      const match = items[matchIndex];
      return {
        isTopTrader: true,
        rank: matchIndex + 1,
        volume: match.volume ?? 0,
        trades: match.trade ?? 0,
        buys: match.tradeBuy ?? 0,
        sells: match.tradeSell ?? 0,
        volumeBuy: match.volumeBuy ?? 0,
        volumeSell: match.volumeSell ?? 0,
      };
    }

    return { isTopTrader: false };
  }
}
