/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type ProposeOrderDto = {
  /**
   * Order action
   */
  action: 'buy' | 'sell';
  /**
   * Token contract address
   */
  address: string;
  /**
   * Amount to trade (percentage, "all", or USD value as string)
   */
  amount: string;
  /**
   * Analysis score (0–100)
   */
  analysis_score?: number;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Entry price in USD
   */
  entry_price?: number;
  /**
   * Token name
   */
  name?: string;
  /**
   * Percent of portfolio
   */
  percent_of_portfolio?: number;
  /**
   * Sell reason (for sell orders)
   */
  reason?: string;
  /**
   * Reasoning for this order
   */
  reasoning?: string;
  /**
   * Risk score (0–100)
   */
  risk_score?: number;
  /**
   * Stop-loss price
   */
  stop_loss?: number;
  /**
   * Token symbol
   */
  symbol: string;
  /**
   * Take-profit levels (array of numbers)
   */
  take_profit_levels?: Array<number>;
  /**
   * Position tier
   */
  tier?: string;
  /**
   * Sell urgency
   */
  urgency?: string;
};
