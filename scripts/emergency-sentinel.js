#!/usr/bin/env node
/**
 * emergency-sentinel.js — Script-only position monitor (no LLM required)
 *
 * Runs when all model providers fail. Pure deterministic logic:
 *   1. Load open positions via cclaw positions list
 *   2. Fetch current prices from DEXScreener
 *   3. Write sell orders for: stop-loss hit, take-profit hit, severe loss (>30%),
 *      liquidity drain (>50% drop), low liquidity (<$5k)
 *      Order write is a 2-call pattern: cclaw orders propose → cclaw orders approve
 *      (stricter than legacy direct INSERT — produces audit trail for both writes)
 *   4. Log to sentinel_log via cclaw logs sentinel append
 *   5. Output JSON summary to stdout
 *
 * Usage:
 *   node scripts/emergency-sentinel.js
 *
 * Env vars: SAFE_ID, PAPER_MODE, CCLAW_API_TOKEN, CCLAW_API_BASE
 *
 * [OPEN-1] AppendSentinelLogDto constrains status to IsIn(['ok','warn','error']).
 * Emergency cycles use status='warn' + check_type='emergency' (no DTO change needed).
 *
 * Ported from direct DB access to cclaw subprocess calls.
 */

import 'dotenv/config';
import { execSync } from 'child_process';
import { log } from './log.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
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
    log('error', 'emergency-sentinel', `runCclaw failed: cmd="${cmd}" status=${status} stderr=${stderr.slice(0, 200)}`);
    return null;
  }
}

/**
 * Load open + partial_exit positions via cclaw.
 * @returns {unknown[]}
 */
function loadPositions() {
  const isPaper = process.env.PAPER_MODE === 'true';
  const mode = isPaper ? 'paper' : 'real';
  const openResult = runCclaw(`cclaw positions list --status open --mode ${mode} --limit 50`);
  const partialResult = runCclaw(`cclaw positions list --status partial_exit --mode ${mode} --limit 50`);

  const openRows = Array.isArray(openResult?.data) ? openResult.data : [];
  const partialRows = Array.isArray(partialResult?.data) ? partialResult.data : [];

  // Sort by created_at DESC (mirrors legacy ORDER BY created_at DESC)
  const all = [...openRows, ...partialRows];
  all.sort((a, b) => {
    const ta = a.created_at ?? '';
    const tb = b.created_at ?? '';
    return tb < ta ? -1 : tb > ta ? 1 : 0;
  });
  return all;
}

/**
 * Get the most recent liquidity snapshot for a token.
 * @param {string} address
 * @param {string} chain
 * @returns {unknown|null}
 */
function getPreviousLiquiditySnapshot(address, chain) {
  const result = runCclaw(`cclaw liquidity list --address ${address} --chain ${chain} --limit 1`);
  const rows = Array.isArray(result?.data) ? result.data : [];
  return rows.length > 0 ? rows[0] : null;
}

async function fetchTokenData(address) {
  try {
    const url = `${DEXSCREENER_BASE}/tokens/${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.sort((a, b) => parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0))[0];
    return pair
      ? {
          price: parseFloat(pair.priceUsd ?? 0),
          liquidity: parseFloat(pair.liquidity?.usd ?? 0),
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Write a sell order via cclaw 2-call pattern:
 *   1. cclaw orders propose → get new order ID
 *   2. cclaw orders approve --by emergency_sentinel
 *
 * This is STRICTER than the legacy direct INSERT — produces an audit
 * trail for both the propose and the approve writes, matching the normal
 * order pipeline audit behavior.
 *
 * @param {unknown} position
 * @param {string} reason
 * @param {string} urgency
 * @returns {string|null} orderId or null on failure
 */
function writeSellOrder(position, reason, urgency) {
  const body = JSON.stringify({
    action: 'sell',
    symbol: position.symbol,
    address: position.address,
    chain: position.chain,
    amount: 'all',
    reason,
    urgency: urgency || 'immediate',
  });

  // Escape single quotes in body for shell safety
  const escapedBody = body.replace(/'/g, "'\\''");
  const proposeResult = runCclaw(`cclaw orders propose --json '${escapedBody}'`);

  if (!proposeResult) {
    log('error', 'emergency-sentinel', `Failed to propose sell order for ${position.symbol}`);
    return null;
  }

  // cclaw orders propose returns the created order object (or { data: order })
  const orderId = proposeResult.id ?? proposeResult.data?.id;
  if (!orderId) {
    log('error', 'emergency-sentinel', `No order ID returned from propose for ${position.symbol}`);
    return null;
  }

  const approveResult = runCclaw(`cclaw orders approve --id ${orderId} --by emergency_sentinel`);
  if (!approveResult) {
    log('error', 'emergency-sentinel', `Failed to approve sell order ${orderId} for ${position.symbol}`);
    // Order was proposed but not approved — not ideal, but leave it pending
    // so a human operator can see it. Do not block the rest of the cycle.
    return orderId;
  }

  return orderId;
}

function getMaxTakeProfit(pos) {
  try {
    const levels = JSON.parse(pos.take_profit_levels || '[]');
    if (!Array.isArray(levels) || levels.length === 0) return null;
    return Math.max(...levels.map((l) => l.price || 0));
  } catch {
    return null;
  }
}

/**
 * Log summary to sentinel_log via cclaw.
 * Uses status='warn' + check_type='emergency' per [OPEN-1]:
 * AppendSentinelLogDto only allows status in ['ok','warn','error'].
 */
function logToSentinel(summary) {
  const body = JSON.stringify({
    check_type: 'emergency',
    positions_checked: summary.positionsChecked,
    alerts_generated: summary.ordersWritten,
    sells_executed: 0,
    status: 'warn',
    summary: `emergency cycle: ${summary.positionsChecked} checked, ${summary.ordersWritten} sells written`,
  });

  const escapedBody = body.replace(/'/g, "'\\''");
  const result = runCclaw(`cclaw logs sentinel append --json '${escapedBody}'`);
  if (!result) {
    log('warn', 'emergency-sentinel', 'Failed to append sentinel log row via cclaw');
  }
}

async function main() {
  log('critical', 'emergency-sentinel', 'Emergency sentinel activated — monitoring positions');

  const positions = loadPositions();

  const result = {
    status: 'ok',
    mode: 'emergency',
    paperMode: process.env.PAPER_MODE === 'true',
    positionsChecked: positions.length,
    ordersWritten: 0,
    orders: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  if (positions.length === 0) {
    result.message = 'No open positions — nothing to protect';
    logToSentinel(result);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  for (const pos of positions) {
    try {
      const data = await fetchTokenData(pos.address);
      if (!data) {
        log('warn', 'emergency-sentinel', `Position check skipped: ${pos.symbol} — failed to fetch price data`);
        result.errors.push({ symbol: pos.symbol, error: 'Failed to fetch price data' });
        continue;
      }

      const currentPrice = data.price;
      const liquidity = data.liquidity;
      const entryPrice = pos.entry_price;
      const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      // Check stop-loss
      if (pos.stop_loss && currentPrice <= pos.stop_loss) {
        const orderId = writeSellOrder(pos, 'stop_loss', 'immediate');
        log(
          'info',
          'emergency-sentinel',
          `Sell order created for ${pos.symbol} — stop_loss hit (price: ${currentPrice}, stop: ${pos.stop_loss})`,
        );
        result.orders.push({
          orderId,
          symbol: pos.symbol,
          reason: 'stop_loss',
          currentPrice,
          stopLoss: pos.stop_loss,
          pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        });
        result.ordersWritten++;
        await new Promise((r) => setTimeout(r, 200));
        continue; // One order per position
      }

      // Check take-profit (parse from take_profit_levels JSON)
      const maxTp = getMaxTakeProfit(pos);
      if (maxTp && currentPrice >= maxTp) {
        const orderId = writeSellOrder(pos, 'take_profit', 'normal');
        log(
          'info',
          'emergency-sentinel',
          `Sell order created for ${pos.symbol} — take_profit hit (price: ${currentPrice}, TP: ${maxTp})`,
        );
        result.orders.push({
          orderId,
          symbol: pos.symbol,
          reason: 'take_profit',
          currentPrice,
          takeProfit: maxTp,
          pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        });
        result.ordersWritten++;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Check severe loss (>30%)
      if (pnlPercent < -30) {
        const orderId = writeSellOrder(pos, 'emergency_severe_loss', 'immediate');
        log(
          'info',
          'emergency-sentinel',
          `Sell order created for ${pos.symbol} — severe loss ${pnlPercent.toFixed(1)}%`,
        );
        result.orders.push({
          orderId,
          symbol: pos.symbol,
          reason: 'severe_loss',
          currentPrice,
          entryPrice,
          pnlPercent: parseFloat(pnlPercent.toFixed(2)),
        });
        result.ordersWritten++;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      // Check liquidity
      const prevSnapshot = getPreviousLiquiditySnapshot(pos.address, pos.chain);
      const liquidityDropPercent = prevSnapshot
        ? ((liquidity - prevSnapshot.liquidity_usd) / prevSnapshot.liquidity_usd) * 100
        : 0;

      if (prevSnapshot && liquidityDropPercent < -50) {
        const orderId = writeSellOrder(pos, 'emergency_liquidity_drain', 'immediate');
        log(
          'info',
          'emergency-sentinel',
          `Sell order created for ${pos.symbol} — liquidity drain ${liquidityDropPercent.toFixed(1)}%`,
        );
        result.orders.push({
          orderId,
          symbol: pos.symbol,
          reason: 'liquidity_drain',
          currentLiquidity: liquidity,
          previousLiquidity: prevSnapshot.liquidity_usd,
          dropPercent: parseFloat(liquidityDropPercent.toFixed(2)),
        });
        result.ordersWritten++;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }

      if (liquidity < 5000) {
        const orderId = writeSellOrder(pos, 'emergency_low_liquidity', 'immediate');
        log(
          'info',
          'emergency-sentinel',
          `Sell order created for ${pos.symbol} — low liquidity $${liquidity.toFixed(0)}`,
        );
        result.orders.push({
          orderId,
          symbol: pos.symbol,
          reason: 'low_liquidity',
          currentLiquidity: liquidity,
        });
        result.ordersWritten++;
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
    } catch (err) {
      log('warn', 'emergency-sentinel', `Position check skipped: ${pos.symbol} — ${err.message}`);
      result.errors.push({ symbol: pos.symbol, error: err.message });
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  log(
    'info',
    'emergency-sentinel',
    `Emergency cycle complete: ${result.positionsChecked} checked, ${result.ordersWritten} sell orders written, ${result.errors.length} errors`,
  );
  logToSentinel(result);
  console.log(JSON.stringify(result, null, 2));
}

main();
