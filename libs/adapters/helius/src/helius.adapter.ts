/**
 * HeliusAdapter — HTTP client for the Helius parsed-transaction API.
 *
 * All methods follow ADR-0026: config access uses per-field
 * `configService.get<T>('FIELD')` — never aggregate config objects.
 *
 * Authentication: API key is passed as a query-string parameter
 * (`?api-key=<value>`) in the request URL. This is Helius's documented
 * pattern (not a header). The URL must NEVER be logged in full — the
 * redactor's `RE_QUERY_APIKEY` pattern covers `?api-key=...` and will
 * strip the value even if it leaks into an error message.
 *
 * Security note: RE_QUERY_APIKEY in libs/logger/src/redactor.ts matches both
 * the Helius "?api-key=" variant and the Etherscan "?apikey=" (no dash) variant.
 * Always pass a redacted form of the URL to structured logger fields — never the raw URL.
 *
 * Cancellation: every method accepts an optional `AbortSignal` for
 * per-call wall-clock caps. Pass `AbortSignal.timeout(ms)` for a simple
 * deadline without maintaining an AbortController reference.
 *
 * Return shape: the Helius `/v0/addresses/{address}/transactions` endpoint
 * returns an array of transaction objects. Only the fields consumed by
 * `extractSolanaSwaps()` are typed here (type, tokenTransfers, signature,
 * timestamp). Unknown fields are safe to ignore.
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
 * Thrown when `HELIUS_API_KEY` is absent from the runtime config.
 *
 * The schema marks the key optional (Solana activity polling is skipped
 * when the key is absent), so this error is thrown lazily (on first call)
 * rather than at boot time.
 */
export class HeliusApiKeyMissingError extends Error {
  constructor() {
    super('HELIUS_API_KEY is not configured — Helius calls are unavailable');
    this.name = 'HeliusApiKeyMissingError';
  }
}

/**
 * Thrown when Helius returns an unexpected non-2xx HTTP status.
 */
export class HeliusApiError extends Error {
  constructor(
    /** Redacted URL (api-key stripped) — safe to include in logs. */
    public readonly redactedUrl: string,
    public readonly status: number,
  ) {
    super(`Helius API error: HTTP ${status} from ${redactedUrl}`);
    this.name = 'HeliusApiError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/**
 * A single token transfer leg within a Helius parsed transaction.
 *
 * Field names match the Helius API response shape exactly so that
 * `extractSolanaSwaps()` can consume this type without an intermediate
 * mapping step.
 */
export interface HeliusTokenTransfer {
  /** SPL token mint address (base58). */
  mint: string;
  /** Human-readable token symbol, if Helius enriched it. */
  tokenSymbol?: string | null;
  /** Human-readable token name, if Helius enriched it. */
  tokenName?: string | null;
  /** Wallet address that sent the tokens. */
  fromUserAccount: string;
  /** Wallet address that received the tokens. */
  toUserAccount: string;
  /** Transfer amount (raw, as returned by Helius — decimal string or number). */
  tokenAmount: string | number;
}

/**
 * A single parsed transaction from the Helius API.
 *
 * Helius returns richer objects; only the fields consumed by the swap
 * extraction logic are typed here. The `Record<string, unknown>` index
 * signature allows unknown additional fields without type errors.
 */
export interface HeliusTransaction {
  /** Solana transaction signature (base58). */
  signature: string;
  /** Unix timestamp (seconds). */
  timestamp: number;
  /** Helius transaction type classification (e.g. 'SWAP', 'TRANSFER'). */
  type: string;
  /** Token transfer legs parsed by Helius. */
  tokenTransfers: HeliusTokenTransfer[];
  /** Allow additional fields from the Helius response without type errors. */
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Default transaction limit per Helius request (mirrors legacy TOKENTX_OFFSET = 50). */
const DEFAULT_LIMIT = 50;

/** Helius API base URL. */
const HELIUS_BASE_URL = 'https://api.helius.xyz/v0/addresses';

/**
 * NestJS injectable adapter for the Helius REST API.
 *
 * Inject in modules via `HeliusModule.imports` → provider registration.
 * The module and barrel re-export this class; no direct instantiation.
 */
@Injectable()
export class HeliusAdapter {
  private readonly logger = new Logger(HeliusAdapter.name);

  constructor(private readonly configService: ConfigService) {}

  /**
   * Resolve and validate the Helius API key from config.
   *
   * Called lazily (not in constructor) so that boot does not fail when
   * the key is absent and the caller handles the `HeliusApiKeyMissingError`.
   *
   * ADR-0026: per-field get, not aggregate config fetch.
   */
  private getApiKey(): string {
    const key = this.configService.get<string>('HELIUS_API_KEY');
    if (!key) throw new HeliusApiKeyMissingError();
    return key;
  }

  /**
   * Build a redacted form of the URL safe for logging.
   *
   * Replaces the `api-key` query param value with `[REDACTED]`.
   * The `RE_QUERY_APIKEY` pattern in redactor.ts also covers this, but
   * defence-in-depth: never pass the raw URL to any logger call.
   */
  private redactUrl(rawUrl: string): string {
    return rawUrl.replace(/([?&]api-key=)[^&\s]*/gi, '$1[REDACTED]');
  }

  /**
   * Fetch parsed transactions for a Solana wallet address from Helius.
   *
   * Returns `null` when:
   * - `HELIUS_API_KEY` is absent (logs a debug message, does not throw)
   * - The Helius API returns a non-array body
   *
   * Returns an empty array when Helius returns an empty JSON array (no txs).
   *
   * @param address - Solana wallet address (base58).
   * @param opts.limit - Max number of transactions to return (default 50).
   * @param opts.signal - Optional AbortSignal for wall-clock cap.
   *
   * @throws {HeliusApiError} if the API returns a non-2xx status.
   * @throws Any `fetch` error (network, timeout from AbortSignal) propagates as-is.
   */
  async getParsedTransactions(
    address: string,
    opts: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<HeliusTransaction[] | null> {
    const { limit = DEFAULT_LIMIT, signal } = opts;

    let apiKey: string;
    try {
      apiKey = this.getApiKey();
    } catch (err) {
      if (err instanceof HeliusApiKeyMissingError) {
        this.logger.debug('helius.getParsedTransactions: HELIUS_API_KEY not configured — skipping');
        return null;
      }
      throw err;
    }

    // Build URL with api-key in query string (Helius convention).
    // NEVER log rawUrl — only log redactedUrl.
    const rawUrl = `${HELIUS_BASE_URL}/${address}/transactions?api-key=${apiKey}&limit=${limit}`;
    const redactedUrl = this.redactUrl(rawUrl);

    this.logger.debug(`helius.getParsedTransactions: fetching txs for ${address} url=${redactedUrl}`);

    const response = await fetch(rawUrl, { signal });

    if (!response.ok) {
      throw new HeliusApiError(redactedUrl, response.status);
    }

    const data = (await response.json()) as unknown;

    if (!Array.isArray(data)) {
      this.logger.debug(`helius.getParsedTransactions: unexpected response shape for ${address}`);
      return null;
    }

    // Cast: Helius returns an array of transaction objects. We trust the
    // shape matches HeliusTransaction based on API contract; extra fields are
    // ignored. The `as HeliusTransaction[]` is intentional — we do not have
    // a full Zod schema for the Helius response (out of scope for P3g1).
    return data as HeliusTransaction[];
  }
}
