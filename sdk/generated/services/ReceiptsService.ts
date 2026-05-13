/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CreateReceiptDto } from '../models/CreateReceiptDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class ReceiptsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List receipts
   * @param status Filter by status
   * @param mode Portfolio mode (real|paper)
   * @param since Filter receipts created after this ISO timestamp
   * @param until Filter receipts created before this ISO timestamp
   * @param orderId Filter by order ID
   * @param limit Maximum results (default 50, max 200)
   * @param cursor Cursor for pagination (last receipt id)
   * @returns any List of receipts
   * @throws ApiError
   */
  public receiptsControllerList(
    status?: string,
    mode?: 'real' | 'paper',
    since?: string,
    until?: string,
    orderId?: string,
    limit?: number,
    cursor?: string,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/receipts',
      query: {
        status: status,
        mode: mode,
        since: since,
        until: until,
        orderId: orderId,
        limit: limit,
        cursor: cursor,
      },
    });
  }
  /**
   * Create a receipt (executor writes execution records)
   * @param requestBody
   * @returns any Receipt created
   * @throws ApiError
   */
  public receiptsControllerCreate(requestBody: CreateReceiptDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/receipts',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get a receipt by ID
   * @param id Receipt ID
   * @param mode
   * @returns any Receipt found
   * @throws ApiError
   */
  public receiptsControllerGetById(id: string, mode: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/receipts/{id}',
      path: {
        id: id,
      },
      query: {
        mode: mode,
      },
      errors: {
        404: `Receipt not found`,
      },
    });
  }
}
