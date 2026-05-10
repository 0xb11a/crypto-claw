/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreatePositionDto = {
  /**
   * Token contract address
   */
  address: string;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Entry date (ISO date string)
   */
  entry_date?: string;
  /**
   * Entry price in USD
   */
  entry_price: number;
  /**
   * Portfolio mode (default: real)
   */
  mode?: 'real' | 'paper';
  /**
   * Token name
   */
  name?: string;
  /**
   * Narrative tag
   */
  narrative?: string;
  /**
   * Notes
   */
  notes?: string;
  /**
   * Token quantity
   */
  quantity: number;
  /**
   * Stop-loss price in USD
   */
  stop_loss: number;
  /**
   * Token symbol
   */
  symbol: string;
  /**
   * Take-profit price levels (JSON array of numbers)
   */
  take_profit_levels: Array<number>;
  /**
   * Position tier
   */
  tier: 'base' | 'conviction' | 'moonshot';
};
