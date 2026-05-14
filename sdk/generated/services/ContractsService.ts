/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddContractSnapshotDto } from '../models/AddContractSnapshotDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class ContractsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List recent contract safety snapshots
   * @param address Contract address
   * @param chain Chain identifier
   * @param limit Maximum number of rows to return (default: 5)
   * @returns any Contract snapshot list
   * @throws ApiError
   */
  public contractsControllerList(address: string, chain: string, limit: number = 5): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/contracts/snapshots',
      query: {
        address: address,
        chain: chain,
        limit: limit,
      },
      errors: {
        400: `Missing or invalid query params`,
      },
    });
  }
  /**
   * Add a contract safety snapshot
   * @param requestBody
   * @returns any Snapshot added
   * @throws ApiError
   */
  public contractsControllerAdd(requestBody: AddContractSnapshotDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/contracts/snapshots',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error (e.g. json exceeds 65KB)`,
      },
    });
  }
}
