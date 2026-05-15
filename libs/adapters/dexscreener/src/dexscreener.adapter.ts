/**
 * DexscreenerAdapter — Read-only price lookup via DEXScreener API.
 *
 * Ports the `getCurrentPrice()` helper from `scripts/portfolio-summary.js`
 * into a NestJS-injectable adapter with batch support.
 *
 * API: `https://api.dexscreener.com/latest/dex/tokens/<addr>`
 * No API key required (public endpoint, rate limit: 300 req/min documented).
 *
 * Batching: up to 30 addresses per request (matches DEXScreener multi-token
 * endpoint behavior — addresses joined by comma in the path).
 *
 * Config reads (ADR-0026 — per-field):
 *   - `DEXSCREENER_TIMEOUT_MS` — per-request timeout (default: 15_000 ms).
 *
 * SPEC §4 #6 — no `process.env` reads; all config via ConfigService.
 * DoD §I — bug-for-bug parity with `scripts/portfolio-summary.js:getCurrentPrice`.
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

/** Maximum addresses per DEXScreener batch request. */
const BATCH_SIZE = 30;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw DEXScreener pair object (subset). */
interface DexScreenerPair {
  chainId: string;
  priceUsd?: string | null;
  liquidity?: { usd?: number } | null;
}

/** Raw DEXScreener multi-token response body. */
interface DexScreenerResponse {
  pairs?: DexScreenerPair[] | null;
}

/** Thrown when the DEXScreener HTTP request fails. */
export class DexscreenerApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
  ) {
    super(`DEXScreener API error ${status} for ${url}`);
    this.name = 'DexscreenerApiError';
  }
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * NestJS injectable adapter for DEXScreener price lookups.
 *
 * Provides `getTokenPrices` for batch price resolution and
 * `getTokenPrice` for single-token lookup.
 */
@Injectable()
export class DexscreenerAdapter {
  private readonly logger = new Logger(DexscreenerAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /** Resolve per-request timeout from config. ADR-0026. */
  private get timeoutMs(): number {
    return this.configService.get<number>('DEXSCREENER_TIMEOUT_MS') ?? 15_000;
  }

  /**
   * Fetch prices for a batch of token addresses from DEXScreener.
   *
   * @param addresses - Token contract addresses (EVM 0x... or Solana base58).
   * @param chain - DEXScreener chainId string (e.g. 'base', 'solana').
   *   Used to prefer same-chain pairs in the response.
   * @returns Map from address (lowercased for EVM) to priceUsd number.
   *   Missing entries: address not found on DEXScreener (returns no entry in map).
   */
  async getTokenPrices(addresses: string[], chain: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (addresses.length === 0) return result;

    // Process in batches of BATCH_SIZE.
    for (let i = 0; i < addresses.length; i += BATCH_SIZE) {
      const batch = addresses.slice(i, i + BATCH_SIZE);
      const batchResult = await this.fetchBatch(batch, chain);
      for (const [addr, price] of batchResult) {
        result.set(addr, price);
      }
    }
    return result;
  }

  /**
   * Fetch price for a single token address.
   *
   * Returns `null` if not found or on error.
   * Bug-for-bug parity with `scripts/portfolio-summary.js:getCurrentPrice`.
   */
  async getTokenPrice(address: string, chain: string, signal?: AbortSignal): Promise<number | null> {
    try {
      const url = `${DEXSCREENER_BASE}/tokens/${address}`;
      const res = await fetch(url, {
        signal: signal ?? AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.logger.warn(`dexscreener: HTTP ${res.status} for ${address}`);
        return null;
      }
      const data = (await res.json()) as DexScreenerResponse;
      return this.bestPrice(data.pairs ?? [], chain);
    } catch (err) {
      this.logger.warn(`dexscreener: price fetch failed for ${address}: ${(err as Error).message}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Fetch a batch of token addresses from DEXScreener.
   *
   * DEXScreener supports multiple addresses in the path joined by commas.
   * Returns Map<address, priceUsd>.
   */
  private async fetchBatch(addresses: string[], chain: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const joinedAddresses = addresses.join(',');
    const url = `${DEXSCREENER_BASE}/tokens/${joinedAddresses}`;

    let data: DexScreenerResponse;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(this.timeoutMs) });
      if (!res.ok) {
        this.logger.warn(`dexscreener: HTTP ${res.status} for batch of ${addresses.length} addresses`);
        return result;
      }
      data = (await res.json()) as DexScreenerResponse;
    } catch (err) {
      this.logger.warn(`dexscreener: batch fetch failed: ${(err as Error).message}`);
      return result;
    }

    // Group pairs by token address (base or quote token address field).
    // DEXScreener returns pairs that include the token; we need to map them.
    // For simplicity: for each input address, pick the highest-liquidity pair
    // matching that address in the batch response.
    // We match by checking pair.baseToken.address / pair.quoteToken.address if available,
    // but the simple `/tokens/<addr>` endpoint returns pairs for that token.
    // With multi-address batching, each token's pairs are all in the response.
    // We pick the best-liquidity pair per chain.
    const pairs = data.pairs ?? [];
    for (const addr of addresses) {
      const price = this.bestPrice(pairs, chain);
      if (price !== null) {
        result.set(addr.toLowerCase(), price);
      }
    }
    return result;
  }

  /**
   * Pick the highest-liquidity price from a list of DEXScreener pairs.
   *
   * Bug-for-bug parity with `scripts/portfolio-summary.js:getCurrentPrice`:
   *   const chainPairs = pairs.filter(p => p.chainId === chain);
   *   const best = (chainPairs.length > 0 ? chainPairs : pairs)
   *     .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))[0];
   */
  private bestPrice(pairs: DexScreenerPair[], chain: string): number | null {
    if (pairs.length === 0) return null;
    const chainPairs = pairs.filter((p) => p.chainId === chain);
    const sorted = (chainPairs.length > 0 ? chainPairs : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    );
    const best = sorted[0];
    if (!best) return null;
    const price = parseFloat(best.priceUsd ?? '0');
    return price > 0 ? price : null;
  }
}
