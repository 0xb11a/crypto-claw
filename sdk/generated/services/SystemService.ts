/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { SetCashDto } from '../models/SetCashDto';
import type { SetMetaDto } from '../models/SetMetaDto';
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
   * Set cash balance for a chain
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
}
