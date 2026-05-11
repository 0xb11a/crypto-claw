/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { PingHeartbeatDto } from '../models/PingHeartbeatDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class HeartbeatService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List all heartbeat rows
   * @param agent Filter by agent name (research|sentinel|executor|observer|system)
   * @returns any List of heartbeat rows
   * @throws ApiError
   */
  public heartbeatControllerList(agent?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/heartbeat',
      query: {
        agent: agent,
      },
    });
  }
  /**
   * Get heartbeat rows for a specific agent
   * @param agent Agent name
   * @returns any Agent heartbeat rows
   * @throws ApiError
   */
  public heartbeatControllerGetByAgent(agent: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/heartbeat/{agent}',
      path: {
        agent: agent,
      },
      errors: {
        404: `Agent not found`,
      },
    });
  }
  /**
   * Get overdue checks for an agent
   * @param agent Agent name
   * @returns any Overdue check status
   * @throws ApiError
   */
  public heartbeatControllerGetOverdue(agent: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/heartbeat/{agent}/overdue',
      path: {
        agent: agent,
      },
    });
  }
  /**
   * Ping (update) a heartbeat check
   * @param agent Agent name
   * @param checkType Check type (e.g. price_check, process_orders)
   * @param requestBody
   * @returns any Heartbeat updated
   * @throws ApiError
   */
  public heartbeatControllerPing(
    agent: string,
    checkType: string,
    requestBody: PingHeartbeatDto,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/heartbeat/{agent}/{checkType}/ping',
      path: {
        agent: agent,
        checkType: checkType,
      },
      body: requestBody,
      mediaType: 'application/json',
    });
  }
}
