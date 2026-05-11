/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreateReceiptDto = {
  /**
   * Trade action
   */
  action: 'buy' | 'sell';
  /**
   * Token contract address
   */
  address: string;
  /**
   * Amount traded in USD
   */
  amount?: number;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Error message if execution failed
   */
  error?: string;
  /**
   * Actual executed price
   */
  executed_price?: number;
  /**
   * Expected price at order time
   */
  expected_price?: number;
  /**
   * Gas used (as string for large integers)
   */
  gas_used?: string;
  /**
   * Portfolio mode (real|paper)
   */
  mode?: 'real' | 'paper';
  /**
   * Additional notes
   */
  notes?: string;
  /**
   * On-chain transaction hash
   */
  onchain_tx_hash?: string;
  /**
   * Associated order ID
   */
  order_id: string;
  /**
   * Associated position ID
   */
  position_id?: string;
  /**
   * Token quantity
   */
  quantity?: number;
  /**
   * Safe nonce used
   */
  safe_nonce?: number;
  /**
   * Safe transaction hash (EVM)
   */
  safe_tx_hash?: string;
  /**
   * Number of signatures collected
   */
  signatures_collected?: number;
  /**
   * Number of signatures required
   */
  signatures_required?: number;
  /**
   * Price slippage percentage
   */
  slippage?: number;
  /**
   * Receipt status
   */
  status: string;
  /**
   * Token symbol
   */
  symbol: string;
};
