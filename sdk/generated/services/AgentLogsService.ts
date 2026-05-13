/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AppendExecutorLogDto } from '../models/AppendExecutorLogDto';
import type { AppendObserverLogDto } from '../models/AppendObserverLogDto';
import type { AppendResearchLogDto } from '../models/AppendResearchLogDto';
import type { AppendSentinelLogDto } from '../models/AppendSentinelLogDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class AgentLogsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List recent executor log rows
   * @param limit Maximum number of rows to return
   * @param since ISO-8601 datetime — return rows created at or after this time
   * @param status Filter by status (ok | warn | error)
   * @returns any Executor log list
   * @throws ApiError
   */
  public executorLogControllerList(limit: number = 50, since?: string, status?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/executor',
      query: {
        limit: limit,
        since: since,
        status: status,
      },
    });
  }
  /**
   * Append an executor log row
   * @param requestBody
   * @returns any Row appended
   * @throws ApiError
   */
  public executorLogControllerAppend(requestBody: AppendExecutorLogDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/logs/executor',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get an executor log row by ID
   * @param id Row integer ID
   * @returns any Executor log row
   * @throws ApiError
   */
  public executorLogControllerGetById(id: number): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/executor/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Row not found`,
      },
    });
  }
  /**
   * List recent observer log rows
   * @param limit Maximum number of rows to return
   * @param since ISO-8601 datetime — return rows created at or after this time
   * @param status Filter by status (ok | warn | error)
   * @returns any Observer log list
   * @throws ApiError
   */
  public observerLogControllerList(limit: number = 50, since?: string, status?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/observer',
      query: {
        limit: limit,
        since: since,
        status: status,
      },
    });
  }
  /**
   * Append an observer log row
   * @param requestBody
   * @returns any Row appended
   * @throws ApiError
   */
  public observerLogControllerAppend(requestBody: AppendObserverLogDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/logs/observer',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get an observer log row by ID
   * @param id Row integer ID
   * @returns any Observer log row
   * @throws ApiError
   */
  public observerLogControllerGetById(id: number): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/observer/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Row not found`,
      },
    });
  }
  /**
   * List recent research log rows
   * @param limit Maximum number of rows to return
   * @param since ISO-8601 datetime — return rows created at or after this time
   * @param status Filter by status (ok | warn | error)
   * @returns any Research log list
   * @throws ApiError
   */
  public researchLogControllerList(limit: number = 50, since?: string, status?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/research',
      query: {
        limit: limit,
        since: since,
        status: status,
      },
    });
  }
  /**
   * Append a research log row
   * @param requestBody
   * @returns any Row appended
   * @throws ApiError
   */
  public researchLogControllerAppend(requestBody: AppendResearchLogDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/logs/research',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get a research log row by ID
   * @param id Row integer ID
   * @returns any Research log row
   * @throws ApiError
   */
  public researchLogControllerGetById(id: number): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/research/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Row not found`,
      },
    });
  }
  /**
   * List recent sentinel log rows
   * @param limit Maximum number of rows to return
   * @param since ISO-8601 datetime — return rows created at or after this time
   * @param status Filter by status (ok | warn | error)
   * @returns any Sentinel log list
   * @throws ApiError
   */
  public sentinelLogControllerList(limit: number = 50, since?: string, status?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/sentinel',
      query: {
        limit: limit,
        since: since,
        status: status,
      },
    });
  }
  /**
   * Append a sentinel log row
   * @param requestBody
   * @returns any Row appended
   * @throws ApiError
   */
  public sentinelLogControllerAppend(requestBody: AppendSentinelLogDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/logs/sentinel',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get a sentinel log row by ID
   * @param id Row integer ID
   * @returns any Sentinel log row
   * @throws ApiError
   */
  public sentinelLogControllerGetById(id: number): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/logs/sentinel/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Row not found`,
      },
    });
  }
}
