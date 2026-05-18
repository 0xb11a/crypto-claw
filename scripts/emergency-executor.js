#!/usr/bin/env node
/**
 * emergency-executor.js — Script-only sell order executor (no LLM required)
 *
 * Runs when all model providers fail. Processes SELL orders only:
 *   1. Query approved sell orders via cclaw orders list
 *   2. For each sell order: call cclaw orders execute --id X
 *      (returns 202 enqueued; NestJS ExecuteOrderProcessor handles execution
 *      including paper mode simulation — chain-agnostic)
 *   3. Log via cclaw logs executor append
 *   4. Output JSON summary
 *
 * Deliberately excludes buy orders — automated buying without LLM reasoning
 * violates the safety model.
 *
 * Usage:
 *   node scripts/emergency-executor.js
 *
 * Env vars: SAFE_ID, PAPER_MODE, CCLAW_API_TOKEN, CCLAW_API_BASE
 *
 * NOTE: The legacy implementation called `execSync('node execute-trade-*.js')`
 * which was already broken in P5 (those scripts were deleted). This port
 * replaces that broken path with `cclaw orders execute --id X` which enqueues
 * via BullMQ and is chain-agnostic (drops the former chains.js import).
 * The stdout summary values now mean "enqueued" rather than "executed" —
 * this matches ADR-0027 async execution semantics and the executor heartbeat
 * behavior documented in runbook §14.2.
 *
 * [OPEN-1] AppendExecutorLogDto constrains status to IsIn(['ok','warn','error']).
 * Emergency cycles use status='warn'; signal via summary prefix '[emergency]'.
 *
 * Ported from direct DB access to cclaw subprocess calls.
 */

import { execSync } from 'child_process';
import { log } from './log.js';

const CCLAW_TIMEOUT_MS = 10_000;

/**
 * Run a cclaw command and return parsed JSON output, or null on failure.
 * @param {string} cmd
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
  } catch (err) {
    // Surface failures to system.log so plumbing regressions (auth missing,
    // cclaw not in PATH, API down) don't silently convert emergency-mode
    // into a no-op while the wrapper reports {status:'ok'}. See P5b deletion
    // security-auditor finding #1+#2.
    const stderr = err?.stderr?.toString?.() ?? '';
    const status = err?.status ?? 'unknown';
    log('error', 'emergency-executor', `runCclaw failed: cmd="${cmd}" status=${status} stderr=${stderr.slice(0, 200)}`);
    return null;
  }
}

/**
 * Get all approved sell orders.
 * @returns {unknown[]}
 */
function getPendingSells() {
  const result = runCclaw('cclaw orders list --status approved --action sell --limit 50');
  return Array.isArray(result?.data) ? result.data : [];
}

/**
 * Enqueue a sell order for execution via cclaw orders execute.
 * Returns 202 (enqueued) — ExecuteOrderProcessor handles actual execution.
 * @param {string} orderId
 * @returns {boolean} true if enqueue succeeded
 */
function executeOrder(orderId) {
  const result = runCclaw(`cclaw orders execute --id ${orderId}`);
  return result !== null;
}

/**
 * Log summary to executor_log via cclaw.
 * Uses status='warn' + '[emergency]' summary prefix per [OPEN-1]:
 * AppendExecutorLogDto only allows status in ['ok','warn','error'].
 */
function logToExecutor(summary) {
  const body = JSON.stringify({
    sell_orders_processed: summary.sellsProcessed,
    buy_orders_processed: 0,
    pending_checked: summary.sellsFound,
    success_count: summary.sellsProcessed,
    fail_count: summary.sellsFailed,
    status: 'warn',
    summary: `[emergency] ${summary.sellsProcessed} enqueued, ${summary.sellsFailed} failed`,
  });

  const escapedBody = body.replace(/'/g, "'\\''");
  const result = runCclaw(`cclaw logs executor append --json '${escapedBody}'`);
  if (!result) {
    log('warn', 'emergency-executor', 'Failed to append executor log row via cclaw');
  }
}

async function main() {
  log('critical', 'emergency-executor', 'Emergency executor activated — processing sell orders only');

  const pendingSells = getPendingSells();

  const result = {
    status: 'ok',
    mode: 'emergency',
    paperMode: process.env.PAPER_MODE === 'true',
    sellsFound: pendingSells.length,
    sellsProcessed: 0,
    sellsFailed: 0,
    results: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  if (pendingSells.length === 0) {
    result.message = 'No pending sell orders';
    logToExecutor(result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const order of pendingSells) {
    try {
      const enqueued = executeOrder(order.id);
      if (!enqueued) {
        log('error', 'emergency-executor', `Failed to enqueue sell order ${order.id} (symbol: ${order.symbol})`);
        result.errors.push({
          orderId: order.id,
          symbol: order.symbol,
          error: 'cclaw orders execute returned non-zero',
        });
        result.sellsFailed++;
        continue;
      }

      log('info', 'emergency-executor', `SELL enqueued: ${order.id} (symbol: ${order.symbol})`);
      result.sellsProcessed++;
      result.results.push({
        orderId: order.id,
        symbol: order.symbol,
        chain: order.chain,
        reason: order.reason,
        status: 'enqueued',
      });
    } catch (err) {
      log('error', 'emergency-executor', `SELL failed: ${err.message} (order: ${order.id}, symbol: ${order.symbol})`);
      result.errors.push({ orderId: order.id, symbol: order.symbol, error: err.message });
      result.sellsFailed++;
    }
  }

  log(
    'info',
    'emergency-executor',
    `Emergency cycle complete: ${result.sellsProcessed} enqueued, ${result.sellsFailed} failed`,
  );
  logToExecutor(result);
  console.log(JSON.stringify(result, null, 2));
}

main();
