/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
import type { AddTrackedWalletDto } from '../models/AddTrackedWalletDto';
import type { ProposeWalletDto } from '../models/ProposeWalletDto';
import type { UpdateWalletScoreDto } from '../models/UpdateWalletScoreDto';
import type { CancelablePromise } from '../core/CancelablePromise';
import type { BaseHttpRequest } from '../core/BaseHttpRequest';
export class WalletsService {
  constructor(public readonly httpRequest: BaseHttpRequest) {}
  /**
   * List tracked wallets
   * @param status Filter by status (proposed | scoring | scored | failed)
   * @param type Filter by type (smart_money | dev | whale | deployer | trader | retail)
   * @param chain Filter by chain
   * @param limit Maximum number of rows to return
   * @returns any List of tracked wallets
   * @throws ApiError
   */
  public walletsControllerList(
    status?: string,
    type?: string,
    chain?: string,
    limit: number = 100,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/wallets',
      query: {
        status: status,
        type: type,
        chain: chain,
        limit: limit,
      },
    });
  }
  /**
   * Add or replace a tracked wallet (INSERT OR REPLACE)
   * @param requestBody
   * @returns any Wallet upserted
   * @throws ApiError
   */
  public walletsControllerAdd(requestBody: AddTrackedWalletDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/wallets',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Propose a wallet for scoring (INSERT OR IGNORE)
   * @param requestBody
   * @returns any Wallet proposed (or already exists — no-op)
   * @throws ApiError
   */
  public walletsControllerPropose(requestBody: ProposeWalletDto): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'POST',
      url: '/v1/wallets/propose',
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        400: `Validation error`,
      },
    });
  }
  /**
   * Get smart-money signals (supports --since, --action, --chain, --group_by=token, --min_wallets, --tokens_in_positions)
   * @param since Time window (e.g. 35m, 2h, 1d)
   * @param action Filter by action (buy | sell)
   * @param chain Filter by chain
   * @param groupBy Group results by token
   * @param minWallets Minimum wallet count (requires group_by=token)
   * @param limit Maximum rows to return
   * @param tokensInPositions Only return signals for tokens currently in open positions
   * @returns any List of smart-money signals (ungrouped or aggregated by token)
   * @throws ApiError
   */
  public signalsControllerGetSignals(
    since: string = '35m',
    action?: string,
    chain?: string,
    groupBy?: 'token',
    minWallets?: number,
    limit: number = 100,
    tokensInPositions?: boolean,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/wallets/signals',
      query: {
        since: since,
        action: action,
        chain: chain,
        group_by: groupBy,
        min_wallets: minWallets,
        limit: limit,
        tokens_in_positions: tokensInPositions,
      },
    });
  }
  /**
   * List wallets pending scoring (proposed or failed with retry_count < 3)
   * @param limit Max rows (default 5)
   * @returns any Unscored wallet list
   * @throws ApiError
   */
  public walletsControllerListUnscored(limit?: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/wallets/unscored',
      query: {
        limit: limit,
      },
    });
  }
  /**
   * Remove a tracked wallet
   * @param address Wallet address
   * @param chain Chain identifier
   * @returns any Wallet removed
   * @throws ApiError
   */
  public walletsControllerRemove(address: string, chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'DELETE',
      url: '/v1/wallets/{address}/{chain}',
      path: {
        address: address,
        chain: chain,
      },
      errors: {
        404: `Wallet not found`,
      },
    });
  }
  /**
   * Get a tracked wallet by address and chain
   * @param address Wallet address
   * @param chain Chain identifier
   * @returns any Tracked wallet
   * @throws ApiError
   */
  public walletsControllerGetOne(address: string, chain: string): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'GET',
      url: '/v1/wallets/{address}/{chain}',
      path: {
        address: address,
        chain: chain,
      },
      errors: {
        404: `Wallet not found`,
      },
    });
  }
  /**
   * Update wallet score and status
   * @param address Wallet address
   * @param chain Chain identifier
   * @param requestBody
   * @returns any Score updated
   * @throws ApiError
   */
  public walletsControllerUpdateScore(
    address: string,
    chain: string,
    requestBody: UpdateWalletScoreDto,
  ): CancelablePromise<any> {
    return this.httpRequest.request({
      method: 'PATCH',
      url: '/v1/wallets/{address}/{chain}/score',
      path: {
        address: address,
        chain: chain,
      },
      body: requestBody,
      mediaType: 'application/json',
      errors: {
        404: `Wallet not found`,
      },
    });
  }
}
