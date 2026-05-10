/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class HealthService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * Liveness probe
   * @returns any Service is alive
   * @throws ApiError
   */
  public healthControllerLiveness(): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/healthz',
    });
  }
  /**
   * Readiness probe
   * @returns any The Health Check is successful
   * @throws ApiError
   */
  public healthControllerReadiness(): CancelablePromise<{
    details?: Record<string, Record<string, any>>;
    error?: Record<string, Record<string, any>> | null;
    info?: Record<string, Record<string, any>> | null;
    status?: string;
  }> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/readyz',
      errors: {
        503: `The Health Check is not successful`,
      },
    });
  }
}
