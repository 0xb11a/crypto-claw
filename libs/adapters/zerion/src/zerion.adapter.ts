/**
 * ZerionAdapter — HTTP client for the Zerion Portfolio API.
 *
 * All methods follow ADR-0026: config access uses per-field
 * `configService.get<T>('FIELD')` — never aggregate config objects.
 *
 * Authentication: HTTP Basic auth with the API key as the username and
 * an empty string as the password. The encoded value is:
 *   `Basic ${Buffer.from(ZERION_API_KEY + ':').toString('base64')}`
 * This matches the legacy `scripts/score-wallet.js` auth pattern exactly
 * (verified at `scripts/score-wallet.js:271-274`).
 *
 * Rate limiting: Zerion returns HTTP 429 for quota violations. The
 * adapter throws {@link ZerionRateLimitError} on 429 so callers can
 * decide whether to back off, skip, or bubble up the error.
 *
 * Cancellation: every method accepts an optional `AbortSignal` for
 * per-call wall-clock caps. Pass `AbortSignal.timeout(ms)` for a simple
 * deadline without maintaining an AbortController reference.
 *
 * Solana note: Zerion's `/wallets/{addr}/pnl` endpoint only supports EVM
 * wallets. Calling `getPnl` for a Solana address returns `null` immediately
 * (no network request) — matches legacy `fetchZerionPnl` guard at
 * `scripts/score-wallet.js:267`.
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
 * Thrown when `ZERION_API_KEY` is absent from the runtime config.
 *
 * The schema marks the key optional (wallet-pipeline is skipped when the
 * key is absent), so this error is thrown lazily (on first call) rather
 * than at boot time.
 */
export class ZerionApiKeyMissingError extends Error {
  constructor() {
    super('ZERION_API_KEY is not configured — Zerion calls are unavailable');
    this.name = 'ZerionApiKeyMissingError';
  }
}

/**
 * Thrown when Zerion returns HTTP 429 (Too Many Requests).
 *
 * Processors that catch this error should add the wallet to the failed
 * queue (retry_count++) rather than throwing immediately.
 */
export class ZerionRateLimitError extends Error {
  constructor(public readonly url: string) {
    super(`Zerion API rate limit (429) hit: ${url}`);
    this.name = 'ZerionRateLimitError';
  }
}

/**
 * Thrown when Zerion returns an unexpected non-2xx, non-429 HTTP status.
 */
export class ZerionApiError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`Zerion API error: HTTP ${status} from ${url}`);
    this.name = 'ZerionApiError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/**
 * Normalised PnL result from Zerion's `/v1/wallets/{address}/pnl/` endpoint.
 *
 * Field names match the legacy `fetchZerionPnl` return shape in
 * `scripts/score-wallet.js` exactly — bug-for-bug parity (DoD §I).
 */
export interface ZerionPnlResult {
  /** Data source identifier — always `'zerion'`. */
  source: 'zerion';
  /** Realised gain in USD. */
  realizedPnl: number;
  /** Unrealised gain in USD. */
  unrealizedPnl: number;
  /** Total gain (realised + unrealised); may differ from sum if Zerion has data. */
  totalPnl: number;
  /** Cost basis / total invested in USD. */
  totalInvested: number;
  /**
   * Relative realised gain as a percentage (e.g. 250.5 for +250.5%).
   * `null` when Zerion does not return this field.
   */
  relativeRealizedGain: number | null;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Base URL for the Zerion API. */
const ZERION_BASE_URL = 'https://api.zerion.io/v1';

/**
 * NestJS injectable adapter for the Zerion REST API.
 *
 * Inject in modules via `ZerionModule.imports` → provider registration.
 * The module and barrel re-export this class; no direct instantiation.
 */
@Injectable()
export class ZerionAdapter {
  private readonly logger = new Logger(ZerionAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolve and validate the Zerion API key from config.
   *
   * Called lazily (not in constructor) so that boot does not fail when
   * the key is absent and the caller handles the `ZerionApiKeyMissingError`.
   *
   * ADR-0026: per-field get, not aggregate config fetch.
   */
  private getApiKey(): string {
    const key = this.configService.get<string>('ZERION_API_KEY');
    if (!key) throw new ZerionApiKeyMissingError();
    return key;
  }

  /**
   * Build the Basic auth header value for the given API key.
   *
   * Zerion requires: `Basic <base64(key + ':')>` — the password field is
   * intentionally empty. Verified against `scripts/score-wallet.js:271-274`.
   *
   * The header value is NEVER logged — callers log only the URL.
   */
  private buildAuthHeader(apiKey: string): string {
    // Concatenate key + ':' then base64-encode (empty password per Zerion docs).
    const encoded = Buffer.from(`${apiKey}:`).toString('base64');
    return `Basic ${encoded}`;
  }

  /**
   * Fetch PnL data for a wallet address from Zerion.
   *
   * Returns `null` (without a network request) for Solana addresses, which
   * Zerion does not support — matching the legacy guard in `score-wallet.js:267`.
   *
   * Returns `null` when:
   * - `chain === 'solana'`
   * - `ZERION_API_KEY` is absent (logs a debug message, does not throw)
   * - The Zerion API returns no `data.attributes`
   *
   * @param address - EVM wallet address (0x-prefixed hex).
   * @param opts.chain - Chain identifier. Passing `'solana'` returns `null`.
   * @param opts.signal - Optional AbortSignal for wall-clock cap.
   *
   * @throws {ZerionRateLimitError} if the API returns HTTP 429.
   * @throws {ZerionApiError} if the API returns another non-2xx status.
   * @throws Any `fetch` error (network, timeout from AbortSignal) propagates as-is.
   */
  async getPnl(address: string, opts: { chain?: string; signal?: AbortSignal } = {}): Promise<ZerionPnlResult | null> {
    const { chain, signal } = opts;

    // Zerion only supports EVM — short-circuit for Solana (legacy parity).
    if (chain === 'solana') {
      this.logger.debug(`zerion.getPnl: skipping Solana address ${address}`);
      return null;
    }

    let apiKey: string;
    try {
      apiKey = this.getApiKey();
    } catch (err) {
      if (err instanceof ZerionApiKeyMissingError) {
        this.logger.debug('zerion.getPnl: ZERION_API_KEY not configured — skipping');
        return null;
      }
      throw err;
    }

    const url = `${ZERION_BASE_URL}/wallets/${address}/pnl/?currency=usd`;
    this.logger.debug(`zerion.getPnl: fetching PnL for ${address}`);

    const response = await fetch(url, {
      method: 'GET',
      headers: {
        accept: 'application/json',
        // Authorization header value is never logged — defence-in-depth on top
        // of the pino REDACT_PATHS entry for req.headers.authorization.
        authorization: this.buildAuthHeader(apiKey),
      },
      signal,
    });

    if (response.status === 429) {
      throw new ZerionRateLimitError(url);
    }

    if (!response.ok) {
      throw new ZerionApiError(url, response.status);
    }

    const data = (await response.json()) as {
      data?: {
        attributes?: {
          realized_gain?: number;
          unrealized_gain?: number;
          total_gain?: number;
          realized_cost_basis?: number;
          total_invested?: number;
          relative_realized_gain_percentage?: number;
        };
      };
    };

    const pnl = data.data?.attributes;
    if (!pnl) {
      this.logger.debug(`zerion.getPnl: no attributes in response for ${address}`);
      return null;
    }

    // Mirror legacy field mapping from `scripts/score-wallet.js:284-295` exactly.
    const realizedPnl = pnl.realized_gain ?? 0;
    const unrealizedPnl = pnl.unrealized_gain ?? 0;
    const costBasis = pnl.realized_cost_basis ?? pnl.total_invested ?? 0;

    return {
      source: 'zerion',
      realizedPnl,
      unrealizedPnl,
      totalPnl: pnl.total_gain ?? realizedPnl + unrealizedPnl,
      totalInvested: costBasis > 0 ? costBasis : (pnl.total_invested ?? 0),
      relativeRealizedGain: pnl.relative_realized_gain_percentage ?? null,
    };
  }
}
