/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddLiquiditySnapshotDto } from '../models/AddLiquiditySnapshotDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class LiquidityService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List liquidity snapshots
   * @param address Filter by contract address
   * @param chain Filter by chain
   * @param limit Maximum rows to return (default: 2 per address/chain pair)
   * @returns any List of liquidity snapshots
   * @throws ApiError
   */
  public liquidityControllerList(address?: string, chain?: string, limit: number = 2): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/liquidity',
      query: {
        address: address,
        chain: chain,
        limit: limit,
      },
    });
  }
  /**
   * Add a liquidity snapshot
   * @param requestBody
   * @returns any Snapshot created
   * @throws ApiError
   */
  public liquidityControllerAdd(requestBody: AddLiquiditySnapshotDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/liquidity',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
}
