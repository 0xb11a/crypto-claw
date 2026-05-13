/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ClosePositionDto = {
  /**
   * Exit date (ISO date string)
   */
  exit_date?: string;
  /**
   * Exit price in USD
   */
  exit_price: number;
  /**
   * Exit reason
   */
  exit_reason?: string;
  /**
   * Final P&L percent
   */
  pnl_percent?: number;
  /**
   * Final P&L in USD
   */
  pnl_usd?: number;
};
