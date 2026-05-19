/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SetCashDto } from '../models/SetCashDto';
import type { SetMetaDto } from '../models/SetMetaDto';
import type { SyncPortfolioDto } from '../models/SyncPortfolioDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class SystemService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * Query audit log entries
   * @param identity Filter by identity (e.g. RESEARCH, EXECUTOR)
   * @param role Filter by role (agent|dashboard)
   * @param method Filter by HTTP method
   * @param pathContains Substring match on path
   * @param status Filter by HTTP status code
   * @param since Return entries from this ISO timestamp onward
   * @param until Return entries up to this ISO timestamp
   * @param limit Maximum results (default 100, max 1000)
   * @param cursor Keyset cursor (last seen id from previous page)
   * @returns any Paginated audit entries
   * @throws ApiError
   */
  public auditControllerList(
    identity?: string,
    role?: 'agent' | 'dashboard',
    method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS' | 'HEAD',
    pathContains?: string,
    status?: number,
    since?: string,
    until?: string,
    limit?: number,
    cursor?: string,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/audit',
      query: {
        identity: identity,
        role: role,
        method: method,
        pathContains: pathContains,
        status: status,
        since: since,
        until: until,
        limit: limit,
        cursor: cursor,
      },
      errors: {
        400: `Invalid query parameters`,
      },
    });
  }
  /**
   * Get a single audit entry by ID
   * @param id Audit entry ID
   * @returns any Audit entry found
   * @throws ApiError
   */
  public auditControllerGetById(id: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/audit/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Audit entry not found`,
      },
    });
  }
  /**
   * Get cash balances for all chains
   * @returns any Flat cash breakdown: { [chain]: amount, total }
   * @throws ApiError
   */
  public cashControllerGetAllCash(): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/cash',
    });
  }
  /**
   * Set cash balance for a chain (executor receipt path only)
   * @param requestBody
   * @returns any Cash updated
   * @throws ApiError
   */
  public cashControllerSetCash(requestBody: SetCashDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'PATCH',
      url: '/v1/system/cash',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
        403: `Forbidden — EXECUTOR or LOOP identity required`,
      },
    });
  }
  /**
   * Get cash balance for a specific chain
   * @param chain Chain identifier
   * @returns any Chain cash: { chain, cash }
   * @throws ApiError
   */
  public cashControllerGetCashByChain(chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/cash/{chain}',
      path: {
        chain: chain,
      },
    });
  }
  /**
   * List active and all known chains
   * @returns any { active: string[], all: string[] }
   * @throws ApiError
   */
  public chainsControllerGetChains(): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/chains',
    });
  }
  /**
   * Get configuration for a specific chain
   * @param chain Chain identifier (e.g. base, solana, ethereum)
   * @returns any Full chain configuration including portfolio rules
   * @throws ApiError
   */
  public chainsControllerGetChainConfig(chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/chains/{chain}',
      path: {
        chain: chain,
      },
      errors: {
        404: `Unknown chain`,
      },
    });
  }
  /**
   * Get gas token balance for a chain
   * @param chain Chain identifier
   * @returns any Gas info: { chain, symbol, balance, price, value_usd }
   * @throws ApiError
   */
  public cashControllerGetGas(chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/gas',
      query: {
        chain: chain,
      },
      errors: {
        400: `Missing chain param`,
      },
    });
  }
  /**
   * Get a portfolio_meta key/value
   * @param key portfolio_meta key to look up
   * @returns any Meta key/value pair (value is null if key not found)
   * @throws ApiError
   */
  public metaControllerGetMeta(key: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/meta',
      query: {
        key: key,
      },
      errors: {
        400: `Missing key query param`,
      },
    });
  }
  /**
   * Set a portfolio_meta key/value
   * @param requestBody
   * @returns any Meta key/value updated
   * @throws ApiError
   */
  public metaControllerSetMeta(requestBody: SetMetaDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'PATCH',
      url: '/v1/system/meta',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get portfolio snapshot (all chains or a specific chain)
   * @param chain Filter to a single chain (e.g. base, solana)
   * @param mode Portfolio mode override — defaults to PAPER_MODE config value
   * @returns any Portfolio snapshot with positions and cash balances
   * @throws ApiError
   */
  public portfolioControllerGetPortfolio(chain?: string, mode?: 'real' | 'paper'): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/portfolio',
      query: {
        chain: chain,
        mode: mode,
      },
    });
  }
  /**
   * Enqueue a portfolio reconcile job (fire-and-forget)
   * @param requestBody
   * @returns any Job enqueued (real mode) or skipped (paper mode)
   * @throws ApiError
   */
  public syncPortfolioControllerSyncPortfolio(requestBody: SyncPortfolioDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/system/sync-portfolio',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error — missing chain or invalid trigger`,
        401: `Unauthorized`,
        403: `Forbidden — dashboard role cannot enqueue jobs`,
      },
    });
  }
  /**
   * List portfolio sync history
   * @param chain Filter by chain
   * @param limit Maximum number of rows to return
   * @returns any Portfolio sync history rows
   * @throws ApiError
   */
  public portfolioSyncControllerGetSyncStatus(chain?: string, limit: number = 20): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/sync-status',
      query: {
        chain: chain,
        limit: limit,
      },
    });
  }
  /**
   * Get aggregated trade statistics
   * @param chain Filter stats to a single chain (e.g. base, solana)
   * @param mode Portfolio mode override — defaults to PAPER_MODE config value
   * @returns any Trade statistics: wins/losses/PnL/win-rate/returns
   * @throws ApiError
   */
  public tradeStatsControllerGetTradeStats(chain?: string, mode?: 'real' | 'paper'): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/system/trade-stats',
      query: {
        chain: chain,
        mode: mode,
      },
    });
  }
}
