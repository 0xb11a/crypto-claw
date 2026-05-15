/**
 * SafeTxServiceAdapter — HTTP client for the Safe Transaction Service API.
 *
 * Provides access to Safe multisig info and individual transaction status.
 * Used by the governance-drift and multisig-tracking processors.
 *
 * Base URL is resolved per-chain via `getChain(chain).safe.txServiceUrl`
 * (single source of truth in `libs/chain` — no hardcoded URLs here).
 *
 * Rate limiting: Safe TxService returns HTTP 429. The adapter retries once
 * after a fixed 2 s backoff — mirrors `scripts/check-safe-status.js:retryOnRateLimit`.
 *
 * Cancellation: every method accepts an optional `AbortSignal` for
 * per-call wall-clock caps.
 *
 * SPEC §4 #6 — no `process.env` reads; config injected via ConfigService.
 * SPEC §4 #4 — no signer-key env vars read here.
 * ADR-0026    — per-field config access only.
 */
import { Injectable, Logger } from '@nestjs/common';
import { getChain, isEvm } from '@cclaw/chain';

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

/** Thrown when Safe Transaction Service returns HTTP 429. */
export class SafeTxServiceRateLimitError extends Error {
  constructor(public readonly url: string) {
    super(`Safe TxService rate limit (429) hit: ${url}`);
    this.name = 'SafeTxServiceRateLimitError';
  }
}

/** Thrown when Safe Transaction Service returns an unexpected non-2xx status. */
export class SafeTxServiceApiError extends Error {
  constructor(
    public readonly url: string,
    public readonly status: number,
  ) {
    super(`Safe TxService error: HTTP ${status} from ${url}`);
    this.name = 'SafeTxServiceApiError';
  }
}

/** Thrown when requesting Safe info for a non-EVM chain. */
export class SafeTxServiceChainError extends Error {
  constructor(public readonly chain: string) {
    super(`Safe Transaction Service is not available on non-EVM chain: ${chain}`);
    this.name = 'SafeTxServiceChainError';
  }
}

// ---------------------------------------------------------------------------
// Public return types
// ---------------------------------------------------------------------------

/** Normalised Safe multisig info from the /api/v1/safes/<address>/ endpoint. */
export interface SafeInfo {
  owners: string[];
  threshold: number;
  modules: string[];
  nonce: number;
}

/**
 * Normalised Safe transaction status from the /api/v1/multisig-transactions/<safeTxHash>/ endpoint.
 *
 * Field names match the legacy `checkSafeTransaction` return shape in
 * `scripts/track-multisig.js` — bug-for-bug parity (DoD §I).
 */
export interface SafeTxStatus {
  executed: boolean;
  isSuccessful: boolean;
  txHash: string | null;
  confirmations: number;
  confirmationsRequired: number;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/** Retry delay for HTTP 429 responses (ms). Mirrors legacy script. */
const RATE_LIMIT_RETRY_DELAY_MS = 2_000;

/**
 * NestJS injectable adapter for the Safe Transaction Service REST API.
 *
 * Inject via `SafeTxServiceModule`. Only EVM chains are supported.
 */
@Injectable()
export class SafeTxServiceAdapter {
  private readonly logger = new Logger(SafeTxServiceAdapter.name);

  /** Resolve base URL for the given chain name. Throws for non-EVM chains. */
  private getBaseUrl(chainName: string): string {
    const chain = getChain(chainName);
    if (!isEvm(chain)) {
      throw new SafeTxServiceChainError(chainName);
    }
    return chain.safe.txServiceUrl;
  }

  /**
   * Perform a GET request with a single 429-retry.
   *
   * Ported from `scripts/check-safe-status.js:retryOnRateLimit`.
   * Awaits `RATE_LIMIT_RETRY_DELAY_MS` on 429 then retries once.
   *
   * @throws {SafeTxServiceRateLimitError} if both attempts hit 429.
   * @throws {SafeTxServiceApiError} on other non-2xx status codes.
   */
  private async fetchWithRetry(url: string, signal?: AbortSignal): Promise<Response> {
    const doFetch = () => fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal });

    const first = await doFetch();
    if (first.status === 429) {
      this.logger.warn(`safe-tx-service: 429 on ${url} — waiting ${RATE_LIMIT_RETRY_DELAY_MS}ms before retry`);
      await new Promise((r) => setTimeout(r, RATE_LIMIT_RETRY_DELAY_MS));
      const second = await doFetch();
      if (second.status === 429) {
        throw new SafeTxServiceRateLimitError(url);
      }
      if (!second.ok) throw new SafeTxServiceApiError(url, second.status);
      return second;
    }
    if (!first.ok) throw new SafeTxServiceApiError(url, first.status);
    return first;
  }

  /**
   * Fetch Safe info (owners, threshold, modules, nonce) for an EVM chain.
   *
   * @param chainName - Active chain name (e.g. 'base', 'ethereum').
   * @param safeAddress - The Safe multisig contract address.
   * @param signal - Optional AbortSignal for a wall-clock cap.
   *
   * @throws {SafeTxServiceChainError} for non-EVM chains.
   * @throws {SafeTxServiceRateLimitError} if rate-limited after one retry.
   * @throws {SafeTxServiceApiError} on other HTTP errors.
   */
  async getSafeInfo(chainName: string, safeAddress: string, signal?: AbortSignal): Promise<SafeInfo> {
    const baseUrl = this.getBaseUrl(chainName);
    const url = `${baseUrl}/api/v1/safes/${safeAddress}/`;
    this.logger.debug(`safe-tx-service: getSafeInfo chain=${chainName} address=${safeAddress}`);

    const response = await this.fetchWithRetry(url, signal);
    const data = (await response.json()) as {
      owners?: string[];
      threshold?: number;
      modules?: string[];
      nonce?: number;
    };

    return {
      owners: data.owners ?? [],
      threshold: data.threshold ?? 0,
      modules: data.modules ?? [],
      nonce: data.nonce ?? 0,
    };
  }

  /**
   * Fetch status of a Safe multisig transaction by its safeTxHash.
   *
   * Mirrors `scripts/track-multisig.js:checkSafeTransaction` return shape
   * for bug-for-bug DoD §I parity.
   *
   * @param chainName - Active chain name.
   * @param safeTxHash - The Safe transaction hash (not the on-chain tx hash).
   * @param signal - Optional AbortSignal for a wall-clock cap.
   *
   * @throws {SafeTxServiceChainError} for non-EVM chains.
   * @throws {SafeTxServiceRateLimitError} if rate-limited after one retry.
   * @throws {SafeTxServiceApiError} on other HTTP errors.
   */
  async getTransaction(chainName: string, safeTxHash: string, signal?: AbortSignal): Promise<SafeTxStatus> {
    const baseUrl = this.getBaseUrl(chainName);
    const url = `${baseUrl}/api/v1/multisig-transactions/${safeTxHash}/`;
    this.logger.debug(`safe-tx-service: getTransaction chain=${chainName} safeTxHash=${safeTxHash}`);

    const response = await this.fetchWithRetry(url, signal);
    const data = (await response.json()) as {
      isExecuted?: boolean;
      isSuccessful?: boolean;
      transactionHash?: string | null;
      confirmations?: { owner: string }[];
      confirmationsRequired?: number;
    };

    return {
      executed: data.isExecuted === true,
      isSuccessful: data.isSuccessful === true,
      txHash: data.transactionHash ?? null,
      confirmations: Array.isArray(data.confirmations) ? data.confirmations.length : 0,
      confirmationsRequired: data.confirmationsRequired ?? 0,
    };
  }
}
