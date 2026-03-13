#!/usr/bin/env node
/**
 * heartbeat-check.js — Lightweight DB pre-check for executor/sentinel
 *
 * Checks whether an agent has work to do before invoking it.
 * Returns JSON to stdout. If skip=true, the agent should not be invoked.
 *
 * Usage:
 *   node scripts/heartbeat-check.js --agent executor
 *   node scripts/heartbeat-check.js --agent sentinel
 *
 * Output:
 *   {"agent":"executor","skip":true,"reason":"no pending orders"}
 *   {"agent":"executor","skip":false,"pending_sells":2,"pending_buys":1}
 *   {"agent":"sentinel","skip":true,"reason":"no open positions"}
 *   {"agent":"sentinel","skip":false,"open_positions":3}
 */

import { getDb, close } from './db.js';

const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');
const agent = agentIdx !== -1 && agentIdx + 1 < args.length ? args[agentIdx + 1] : null;

if (!agent || !['executor', 'sentinel'].includes(agent)) {
  console.error(JSON.stringify({ error: 'Usage: heartbeat-check.js --agent executor|sentinel' }));
  process.exit(1);
}

try {
  const db = getDb();
  const paperMode = (process.env.PAPER_MODE || 'false') === 'true';

  if (agent === 'executor') {
    const pendingSells = db.prepare('SELECT COUNT(*) as count FROM sell_orders WHERE executed = 0').get().count;
    const pendingBuys = db.prepare('SELECT COUNT(*) as count FROM approved_trades WHERE executed = 0').get().count;

    let pendingSafe = 0;
    if (!paperMode) {
      pendingSafe = db.prepare("SELECT COUNT(*) as count FROM trade_receipts WHERE status = 'queued_in_safe'").get().count;
    }

    if (pendingSells === 0 && pendingBuys === 0 && pendingSafe === 0) {
      console.log(JSON.stringify({ agent: 'executor', skip: true, reason: 'no pending orders' }));
    } else {
      console.log(JSON.stringify({
        agent: 'executor', skip: false,
        pending_sells: pendingSells,
        pending_buys: pendingBuys,
        ...(pendingSafe > 0 ? { pending_safe: pendingSafe } : {}),
      }));
    }
  } else if (agent === 'sentinel') {
    const table = paperMode ? 'paper_positions' : 'positions';
    const openPositions = db.prepare(`SELECT COUNT(*) as count FROM ${table} WHERE status IN ('open', 'partial_exit')`).get().count;

    if (openPositions === 0) {
      console.log(JSON.stringify({ agent: 'sentinel', skip: true, reason: 'no open positions' }));
    } else {
      console.log(JSON.stringify({ agent: 'sentinel', skip: false, open_positions: openPositions }));
    }
  }

  close();
} catch (e) {
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
