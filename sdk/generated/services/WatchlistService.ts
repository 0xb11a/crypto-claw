/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddWatchlistDto } from '../models/AddWatchlistDto';
import type { UpdateWatchlistDto } from '../models/UpdateWatchlistDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class WatchlistService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List watchlist entries
   * @param status Filter by status. Use 'watching' for active-only, 'all' or omit for all rows.
   * @returns any List of watchlist entries
   * @throws ApiError
   */
  public watchlistControllerList(
    status?: 'watching' | 'entry_hit' | 'expired' | 'removed' | 'all',
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/watchlist',
      query: {
        status: status,
      },
    });
  }
  /**
   * Add a token to the watchlist
   * @param requestBody
   * @returns any Entry created
   * @throws ApiError
   */
  public watchlistControllerAdd(requestBody: AddWatchlistDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/watchlist',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Soft-delete a watchlist entry (sets status=removed)
   * @param id Watchlist entry ID
   * @returns any Entry removed (status=removed)
   * @throws ApiError
   */
  public watchlistControllerRemove(id: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'DELETE',
      url: '/v1/watchlist/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Entry not found`,
      },
    });
  }
  /**
   * Get a watchlist entry by ID
   * @param id Watchlist entry ID
   * @returns any Watchlist entry
   * @throws ApiError
   */
  public watchlistControllerGetById(id: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/watchlist/{id}',
      path: {
        id: id,
      },
      errors: {
        404: `Entry not found`,
      },
    });
  }
  /**
   * Update a watchlist entry
   * @param id Watchlist entry ID
   * @param requestBody
   * @returns any Entry updated
   * @throws ApiError
   */
  public watchlistControllerUpdate(id: string, requestBody: UpdateWatchlistDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'PATCH',
      url: '/v1/watchlist/{id}',
      path: {
        id: id,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Entry not found`,
      },
    });
  }
}
