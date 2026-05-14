/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CacheAnalysisDto } from '../models/CacheAnalysisDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class AnalysisCacheService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List non-expired analysis cache entries
   * @param limit Maximum number of rows to return
   * @returns any Non-expired cache entries
   * @throws ApiError
   */
  public analysisCacheControllerList(limit: number = 50): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/analysis-cache',
      query: {
        limit: limit,
      },
    });
  }
  /**
   * Upsert a token analysis cache entry
   * @param requestBody
   * @returns any Cache entry upserted
   * @throws ApiError
   */
  public analysisCacheControllerUpsert(requestBody: CacheAnalysisDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/analysis-cache',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Check token cache status (non-expired)
   * @param address Token contract address
   * @param chain Chain identifier
   * @returns any Cache entry found
   * @throws ApiError
   */
  public analysisCacheControllerCheck(address: string, chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/analysis-cache/check',
      query: {
        address: address,
        chain: chain,
      },
      errors: {
        404: `No non-expired cache entry for this token`,
      },
    });
  }
  /**
   * Delete all expired analysis cache entries
   * @returns any Expired entries deleted
   * @throws ApiError
   */
  public analysisCacheControllerClearExpired(): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'DELETE',
      url: '/v1/analysis-cache/expired',
    });
  }
}
