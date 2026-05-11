/**
 * Heartbeat cadences — mirrors legacy HEARTBEAT_CADENCES + AGENT_HEARTBEAT_INTERVALS
 * from scripts/db-query.js. Values are copied here; DO NOT import from scripts/.
 *
 * Zero (0) means "runs every outer loop cycle"; callers substitute
 * AGENT_HEARTBEAT_INTERVALS[agent] as the effective cadence for dead-agent detection.
 *
 * If a future PR adds an agent or check, BOTH scripts/db-query.js AND this file
 * must be updated. This mirror is intentional (DoD §I / SPEC §18).
 */

export const HEARTBEAT_CADENCES: Record<string, Record<string, number>> = {
  research: {
    sentinel_alerts: 30,
    market_regime: 60,
    smart_money_signals: 30,
    watchlist_check: 60,
    token_scan: 120,
    narrative_check: 240,
    narrative_deep_scan: 240,
    conviction_scan: 360,
    portfolio_sync: 360,
    rebalance_review: 720,
    base_rebalance: 720,
    daily_summary: 1440,
  },
  sentinel: {
    price_check: 0,
    liquidity_check: 0,
    wallet_check: 0,
    smart_money_exits: 15,
    contract_check: 30,
  },
  executor: {
    process_orders: 0,
  },
  observer: {
    triage: 120,
  },
  // 'system' is a pseudo-agent for background-loop heartbeats (no LLM invocation).
  // Observer reads these via get-heartbeats to detect stopped background loops.
  system: {
    'memory-backup': 15,
  },
};

/**
 * Outer loop interval (minutes) for each LLM agent.
 *
 * Must match the cron / background loop cadence in entrypoint.sh:
 *   research: 30m cron
 *   sentinel: 15-min loop (900s)
 *   executor: 1-min loop (60s)
 *   observer: 120m cron
 *
 * Used as the effective cadence for dead-agent detection when a check's
 * HEARTBEAT_CADENCES value is 0.
 */
export const AGENT_HEARTBEAT_INTERVALS: Record<string, number> = {
  research: 30,
  sentinel: 15,
  executor: 1,
  observer: 120,
};
