#!/usr/bin/env node
/**
 * emergency-sentinel.js — Script-only position monitor (no LLM required)
 *
 * Runs when all model providers fail. Pure deterministic logic:
 *   1. Load open positions from DB (respects PAPER_MODE)
 *   2. Fetch current prices from DEXScreener
 *   3. Write sell orders for: stop-loss hit, take-profit hit, severe loss (>30%),
 *      liquidity drain (>50% drop), low liquidity (<$5k)
 *   4. Log to sentinel_log table
 *   5. Output JSON summary to stdout
 *
 * Usage:
 *   node scripts/emergency-sentinel.js
 *
 * Env vars: SAFE_ID, DB_PATH, PAPER_MODE
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function loadPositions(db) {
  const isPaper = process.env.PAPER_MODE === 'true';
  const table = isPaper ? 'paper_positions' : 'positions';
  return db.prepare(`SELECT * FROM ${table} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`).all();
}

function getPreviousLiquiditySnapshot(db, address, chain) {
  return (
    db
      .prepare('SELECT * FROM liquidity_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT 1')
      .get(address, chain) || null
  );
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

function generateOrderId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function writeSellOrder(db, position, reason, urgency) {
  const orderId = generateOrderId('emg-sell');
  db.prepare(
    `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, status, approved_at, approved_by, status_changed_at, status_changed_by, created_at)
     VALUES (?, 'sell', ?, ?, ?, 'all', ?, ?, 'approved', datetime('now'), 'emergency_sentinel', datetime('now'), 'emergency_sentinel', datetime('now'))`,
  ).run(orderId, position.symbol, position.address, position.chain, reason, urgency || 'immediate');
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

function logToSentinel(db, summary) {
  db.prepare(
    `INSERT INTO sentinel_log (check_type, positions_checked, alerts_generated, sells_executed, status)
     VALUES ('emergency', ?, ?, 0, 'emergency')`,
  ).run(summary.positionsChecked, summary.ordersWritten);
}

async function main() {
  const db = getDb();
  const positions = loadPositions(db);

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
    logToSentinel(db, result);
    console.log(JSON.stringify(result, null, 2));
    close();
    return;
  }

  for (const pos of positions) {
    try {
      const data = await fetchTokenData(pos.address);
      if (!data) {
        result.errors.push({ symbol: pos.symbol, error: 'Failed to fetch price data' });
        continue;
      }

      const currentPrice = data.price;
      const liquidity = data.liquidity;
      const entryPrice = pos.entry_price;
      const pnlPercent = entryPrice > 0 ? ((currentPrice - entryPrice) / entryPrice) * 100 : 0;

      // Check stop-loss
      if (pos.stop_loss && currentPrice <= pos.stop_loss) {
        const orderId = writeSellOrder(db, pos, 'stop_loss', 'immediate');
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
        const orderId = writeSellOrder(db, pos, 'take_profit', 'normal');
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
        const orderId = writeSellOrder(db, pos, 'emergency_severe_loss', 'immediate');
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
      const prevSnapshot = getPreviousLiquiditySnapshot(db, pos.address, pos.chain);
      const liquidityDropPercent = prevSnapshot
        ? ((liquidity - prevSnapshot.liquidity_usd) / prevSnapshot.liquidity_usd) * 100
        : 0;

      if (prevSnapshot && liquidityDropPercent < -50) {
        const orderId = writeSellOrder(db, pos, 'emergency_liquidity_drain', 'immediate');
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
        const orderId = writeSellOrder(db, pos, 'emergency_low_liquidity', 'immediate');
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
      result.errors.push({ symbol: pos.symbol, error: err.message });
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  logToSentinel(db, result);
  console.log(JSON.stringify(result, null, 2));
  close();
}

main();
