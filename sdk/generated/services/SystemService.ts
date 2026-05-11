/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
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
}
