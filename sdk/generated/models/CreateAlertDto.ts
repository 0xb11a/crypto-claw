/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type CreateAlertDto = {
  /**
   * Recommended action
   */
  action?: string;
  /**
   * Alert type (stop_loss|take_profit|rug_warning|liquidity_drop|smart_money_exit|price_drop|price_spike|other)
   */
  alert_type: string;
  /**
   * Chain identifier
   */
  chain: string;
  /**
   * Current price at alert time
   */
  current_price?: number;
  /**
   * Detailed alert information
   */
  details?: string;
  /**
   * Suggested sell amount
   */
  sell_amount?: string;
  /**
   * Severity level
   */
  severity: 'low' | 'medium' | 'high' | 'critical';
  /**
   * Token symbol
   */
  symbol: string;
  /**
   * Price that triggered the alert
   */
  trigger_price?: number;
};
