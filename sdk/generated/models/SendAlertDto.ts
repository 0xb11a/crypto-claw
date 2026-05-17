/* generated using openapi-typescript-codegen -- do not edit */
/* istanbul ignore file */
/* tslint:disable */
/* eslint-disable */
export type SendAlertDto = {
  /**
   * Agent name tag shown in the alert header (e.g. "executor", "sentinel")
   */
  agent: string;
  /**
   * Arbitrary JSON metadata stored in the audit log; not forwarded to Telegram
   */
  data?: Record<string, any>;
  /**
   * Alert message body — HTML-safe text (Telegram 4 000-character cap enforced)
   */
  message: string;
  /**
   * Alert type — determines the Telegram topic topic routing (TG_TOPIC_*)
   */
  type:
    | 'trade_proposal'
    | 'sentinel_alert_followup'
    | 'sell_triggered'
    | 'trade_executed'
    | 'trade_failed'
    | 'trade_retry'
    | 'model_failure'
    | 'emergency_mode'
    | 'rug_warning'
    | 'signer_low_balance'
    | 'recovered'
    | 'system_health'
    | 'heartbeat_summary'
    | 'portfolio_daily'
    | 'rebalance_event';
};
