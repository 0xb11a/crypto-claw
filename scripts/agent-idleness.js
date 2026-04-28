/**
 * agent-idleness.js — Single source of truth for executor/sentinel idleness.
 *
 * Two callers must agree on what "no work" means or Observer will fire false
 * dead-agent alerts:
 *   - heartbeat-check.js: pre-invoke gate, decides whether to wake the agent.
 *   - db-query.js get-heartbeats: tags rows with idle_ok so Observer can
 *     suppress emergency_mode alerts on a row that stopped refreshing because
 *     the loop intentionally skipped invocation.
 *
 * The predicates here are the contract.
 */

/**
 * Executor wakes when at least one order is in 'approved' status.
 * Queued multisig transactions are tracked by track-multisig.js, not the agent.
 */
export function checkExecutorWork(db) {
  const counts = db
    .prepare(
      `
    SELECT
      SUM(CASE WHEN action='sell' THEN 1 ELSE 0 END) as sell_count,
      SUM(CASE WHEN action='buy' AND status = 'approved' THEN 1 ELSE 0 END) as buy_count
    FROM orders WHERE status IN ('approved')
  `,
    )
    .get();
  const pendingSells = counts.sell_count || 0;
  const pendingBuys = counts.buy_count || 0;
  return {
    pendingSells,
    pendingBuys,
    idle: pendingSells === 0 && pendingBuys === 0,
  };
}

/**
 * Sentinel wakes when at least one position is in 'open' or 'partial_exit'.
 * paperMode picks the simulated table.
 */
export function checkSentinelWork(db, paperMode) {
  const table = paperMode ? 'paper_positions' : 'positions';
  const openPositions = db
    .prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status IN ('open', 'partial_exit')`)
    .get().count;
  return {
    openPositions,
    idle: openPositions === 0,
  };
}
