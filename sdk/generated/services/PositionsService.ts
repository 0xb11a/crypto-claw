/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { ClosePositionDto } from '../models/ClosePositionDto';
import type { CreatePositionDto } from '../models/CreatePositionDto';
import type { UpdatePositionDto } from '../models/UpdatePositionDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class PositionsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List positions
   * @param status Filter by position status
   * @param mode Portfolio mode (default: real)
   * @param symbol Filter by token symbol (case-insensitive)
   * @param chain Filter by chain
   * @param limit Maximum number of results (default 50, max 200)
   * @param cursor Cursor for pagination (last position id)
   * @returns any List of positions
   * @throws ApiError
   */
  public positionsControllerList(
    status?: 'open' | 'partial_exit' | 'closed' | 'pending_analysis' | 'draft' | 'pending_exit',
    mode?: 'real' | 'paper',
    symbol?: string,
    chain?: string,
    limit?: number,
    cursor?: string,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/positions',
      query: {
        status: status,
        mode: mode,
        symbol: symbol,
        chain: chain,
        limit: limit,
        cursor: cursor,
      },
    });
  }
  /**
   * Create a new position
   * @param requestBody
   * @returns any Position created
   * @throws ApiError
   */
  public positionsControllerCreate(requestBody: CreatePositionDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/positions',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Delete a position
   * @param id Position ID
   * @param mode
   * @returns void
   * @throws ApiError
   */
  public positionsControllerDelete(id: string, mode: string): CancelablePromise<void> {
    return this.httpRequest.request({
      method: 'DELETE',
      url: '/v1/positions/{id}',
      path: {
        id: id,
      },
      query: {
        mode: mode,
      },
      errors: {
        404: `Position not found`,
      },
    });
  }
  /**
   * Get a position by ID
   * @param id Position ID
   * @param mode
   * @returns any Position found
   * @throws ApiError
   */
  public positionsControllerGetById(id: string, mode: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/positions/{id}',
      path: {
        id: id,
      },
      query: {
        mode: mode,
      },
      errors: {
        404: `Position not found`,
      },
    });
  }
  /**
   * Update a position
   * @param id Position ID
   * @param mode
   * @param requestBody
   * @returns any Position updated
   * @throws ApiError
   */
  public positionsControllerUpdate(id: string, mode: string, requestBody: UpdatePositionDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'PATCH',
      url: '/v1/positions/{id}',
      path: {
        id: id,
      },
      query: {
        mode: mode,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Position not found`,
      },
    });
  }
  /**
   * Close a position
   * @param id Position ID
   * @param mode
   * @param requestBody
   * @returns any Position closed
   * @throws ApiError
   */
  public positionsControllerClose(id: string, mode: string, requestBody: ClosePositionDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/positions/{id}/close',
      path: {
        id: id,
      },
      query: {
        mode: mode,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Position not found`,
      },
    });
  }
}
