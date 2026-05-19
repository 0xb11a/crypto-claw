/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ApproveOrderDto } from '../models/ApproveOrderDto';
import type { CancelOrderDto } from '../models/CancelOrderDto';
import type { ExecuteOrderDto } from '../models/ExecuteOrderDto';
import type { ProposeOrderDto } from '../models/ProposeOrderDto';
import type { RejectOrderDto } from '../models/RejectOrderDto';
import type { RetryOrderDto } from '../models/RetryOrderDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class OrdersService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List orders
   * @param status Filter by order status
   * @param action Filter by action
   * @param pending Show only pending orders
   * @param limit Maximum results (default 50, max 200)
   * @param cursor Cursor for pagination (last order id)
   * @returns any List of orders
   * @throws ApiError
   */
  public ordersControllerList(
    status?: 'pending' | 'approved' | 'rejected' | 'cancelled' | 'executed' | 'failed' | 'expired',
    action?: 'buy' | 'sell',
    pending?: boolean,
    limit?: number,
    cursor?: string,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/orders',
      query: {
        status: status,
        action: action,
        pending: pending,
        limit: limit,
        cursor: cursor,
      },
    });
  }
  /**
   * Propose a new order
   * @param requestBody
   * @returns any Order proposed
   * @throws ApiError
   */
  public ordersControllerPropose(requestBody: ProposeOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
        403: `Identity-action mismatch (SENTINEL can only sell; RESEARCH can only buy)`,
      },
    });
  }
  /**
   * Get an order by ID
   * @param id Order ID
   * @returns any Order found
   * @throws ApiError
   */
  public ordersControllerGetById(id: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/orders/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Order not found`,
      },
    });
  }
  /**
   * Approve an order
   * @param id Order ID
   * @param requestBody
   * @returns any Order approved
   * @throws ApiError
   */
  public ordersControllerApprove(id: string, requestBody: ApproveOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders/{id}/approve',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Order not found`,
        409: `Invalid state transition`,
      },
    });
  }
  /**
   * Cancel an order
   * @param id Order ID
   * @param requestBody
   * @returns any Order cancelled
   * @throws ApiError
   */
  public ordersControllerCancel(id: string, requestBody: CancelOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders/{id}/cancel',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Order not found`,
        409: `Invalid state transition`,
      },
    });
  }
  /**
   * Execute an approved order (enqueues BullMQ job in real mode; short-circuits in paper mode)
   * @param id Order ID
   * @param requestBody
   * @returns any Order execution enqueued (real mode) or completed (paper mode)
   * @throws ApiError
   */
  public ordersControllerExecute(id: string, requestBody: ExecuteOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders/{id}/execute',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Order not found`,
        409: `Order not in approved status`,
      },
    });
  }
  /**
   * Reject an order
   * @param id Order ID
   * @param requestBody
   * @returns any Order rejected
   * @throws ApiError
   */
  public ordersControllerReject(id: string, requestBody: RejectOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders/{id}/reject',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Order not found`,
        409: `Invalid state transition`,
      },
    });
  }
  /**
   * Retry a failed order
   * @param id Order ID
   * @param requestBody
   * @returns any Order retried
   * @throws ApiError
   */
  public ordersControllerRetry(id: string, requestBody: RetryOrderDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/orders/{id}/retry',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Order not found`,
        409: `Only failed orders can be retried`,
      },
    });
  }
}
