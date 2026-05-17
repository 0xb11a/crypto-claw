/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AcknowledgeAlertDto } from '../models/AcknowledgeAlertDto';
import type { CreateAlertDto } from '../models/CreateAlertDto';
import type { SendAlertDto } from '../models/SendAlertDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class AlertsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List sentinel alerts
   * @param unprocessed Return only unprocessed alerts
   * @param alertType Filter by alert type
   * @param chain Filter by chain
   * @param limit Maximum results (default 50, max 200)
   * @param cursor Cursor for pagination (last alert id)
   * @returns any List of alerts
   * @throws ApiError
   */
  public alertsControllerList(
    unprocessed?: boolean,
    alertType?: string,
    chain?: string,
    limit?: number,
    cursor?: string,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/alerts',
      query: {
        unprocessed: unprocessed,
        alertType: alertType,
        chain: chain,
        limit: limit,
        cursor: cursor,
      },
    });
  }
  /**
   * Create a sentinel alert
   * @param requestBody
   * @returns any Alert created
   * @throws ApiError
   */
  public alertsControllerCreate(requestBody: CreateAlertDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/alerts',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Send a Telegram notification (fire-and-forget, 202)
   * @param requestBody
   * @returns any Alert accepted for delivery
   * @throws ApiError
   */
  public alertsControllerSend(requestBody: SendAlertDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/alerts/send',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
        403: `Forbidden — agent role required`,
      },
    });
  }
  /**
   * Get a sentinel alert by ID
   * @param id Alert ID
   * @returns any Alert found
   * @throws ApiError
   */
  public alertsControllerGetById(id: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/alerts/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Alert not found`,
      },
    });
  }
  /**
   * Acknowledge a sentinel alert (idempotent)
   * @param id Alert ID
   * @param requestBody
   * @returns any Alert acknowledged (or already acknowledged — idempotent)
   * @throws ApiError
   */
  public alertsControllerAcknowledge(id: string, requestBody: AcknowledgeAlertDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/alerts/{id}/acknowledge',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Alert not found`,
      },
    });
  }
}
