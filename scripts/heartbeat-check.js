#!/usr/bin/env node
/**
 * heartbeat-check.js — Lightweight cclaw pre-check for executor/sentinel
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
 *
 * Ported from direct DB access to cclaw subprocess calls.
 * On cclaw timeout or non-zero exit, falls back to skip=false (wake the agent)
 * to avoid falsely suppressing an agent when the API is transiently unavailable.
 */

import { execSync } from 'child_process';
import { log } from './log.js';

const CCLAW_TIMEOUT_MS = 5_000;

const args = process.argv.slice(2);
const agentIdx = args.indexOf('--agent');
const agent = agentIdx !== -1 && agentIdx + 1 < args.length ? args[agentIdx + 1] : null;

if (!agent || !['executor', 'sentinel'].includes(agent)) {
  log('error', 'heartbeat-check', `Invalid agent argument: ${agent}`);
  console.error(JSON.stringify({ error: 'Usage: heartbeat-check.js --agent executor|sentinel' }));
  process.exit(1);
}

/**
 * Run a cclaw command and return parsed JSON output, or null on failure.
 * @param {string} cmd - Full cclaw command string (e.g. "cclaw orders list --status approved --action sell --limit 1")
 * @returns {unknown|null}
 */
function runCclaw(cmd) {
  try {
    const raw = execSync(cmd, {
      encoding: 'utf-8',
      timeout: CCLAW_TIMEOUT_MS,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Executor check: wakes when at least one approved sell or buy order exists.
 * Stdout JSON shape: {"agent":"executor","skip":bool,"pending_sells":N,"pending_buys":N}
 *                or {"agent":"executor","skip":true,"reason":"no pending orders"}
 */
function checkExecutorViaCclaw() {
  const sellResult = runCclaw('cclaw orders list --status approved --action sell --limit 1');
  const buyResult = runCclaw('cclaw orders list --status approved --action buy --limit 1');

  // On any cclaw failure, fall back to waking the agent (skip=false) — not suppressing is safe.
  if (sellResult === null || buyResult === null) {
    log('warn', 'heartbeat-check', 'cclaw orders list failed; defaulting to skip=false for executor');
    return { agent: 'executor', skip: false, pending_sells: 0, pending_buys: 0 };
  }

  // cclaw orders list returns { data: Order[] } (paginated shape from API)
  const pendingSells = Array.isArray(sellResult.data) ? sellResult.data.length : 0;
  const pendingBuys = Array.isArray(buyResult.data) ? buyResult.data.length : 0;

  if (pendingSells === 0 && pendingBuys === 0) {
    return { agent: 'executor', skip: true, reason: 'no pending orders' };
  }
  return { agent: 'executor', skip: false, pending_sells: pendingSells, pending_buys: pendingBuys };
}

/**
 * Sentinel check: wakes when at least one open or partial_exit position exists.
 * paperMode drives the --mode flag on positions list.
 * Stdout JSON shape: {"agent":"sentinel","skip":bool,"open_positions":N}
 *                or {"agent":"sentinel","skip":true,"reason":"no open positions"}
 * @param {boolean} paperMode
 */
function checkSentinelViaCclaw(paperMode) {
  const mode = paperMode ? 'paper' : 'real';
  const openResult = runCclaw(`cclaw positions list --status open --mode ${mode} --limit 1`);
  const partialResult = runCclaw(`cclaw positions list --status partial_exit --mode ${mode} --limit 1`);

  // On any cclaw failure, fall back to waking the agent — not suppressing is safe.
  if (openResult === null || partialResult === null) {
    log('warn', 'heartbeat-check', 'cclaw positions list failed; defaulting to skip=false for sentinel');
    return { agent: 'sentinel', skip: false, open_positions: 0 };
  }

  // cclaw positions list returns { data: Position[] } (paginated shape from API)
  const openCount = Array.isArray(openResult.data) ? openResult.data.length : 0;
  const partialCount = Array.isArray(partialResult.data) ? partialResult.data.length : 0;
  const openPositions = openCount + partialCount;

  if (openPositions === 0) {
    return { agent: 'sentinel', skip: true, reason: 'no open positions' };
  }
  return { agent: 'sentinel', skip: false, open_positions: openPositions };
}

try {
  const paperMode = (process.env.PAPER_MODE || 'false') === 'true';

  if (agent === 'executor') {
    const result = checkExecutorViaCclaw();
    console.log(JSON.stringify(result));
  } else if (agent === 'sentinel') {
    const result = checkSentinelViaCclaw(paperMode);
    console.log(JSON.stringify(result));
  }
} catch (e) {
  log('error', 'heartbeat-check', `Check failed for ${agent}: ${e.message}`);
  console.error(JSON.stringify({ error: e.message }));
  process.exit(1);
}
