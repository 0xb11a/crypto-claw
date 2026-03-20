#!/usr/bin/env node
/**
 * check-positions.js — Get current prices for all tracked positions
 *
 * Reads positions from workspace/MEMORY.md portfolio state table,
 * fetches current prices, and outputs comparison with entry/stop/TP levels.
 *
 * Usage:
 *   node scripts/check-positions.js
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function loadPositions() {
  try {
    const db = getDb();
    const isPaper = process.env.PAPER_MODE === 'true';
    const table = isPaper ? 'paper_positions' : 'positions';
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`)
      .all();
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      address: r.address,
      chain: r.chain,
      entryPrice: r.entry_price,
      currentPrice: r.current_price,
      quantity: r.quantity,
      sizePercent: r.percent_of_portfolio ?? null,
      tier: r.tier,
      stopLoss: r.stop_loss,
      status: r.status,
    }));
  } catch {
    return [];
  }
}

async function getCurrentPrice(symbol) {
  try {
    const url = `${DEXSCREENER_BASE}/search?q=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    return pair
      ? {
          price: parseFloat(pair.priceUsd ?? 0),
          liquidity: parseFloat(pair.liquidity?.usd ?? 0),
          volume24h: parseFloat(pair.volume?.h24 ?? 0),
          priceChange24h: parseFloat(pair.priceChange?.h24 ?? 0),
        }
      : null;
  } catch {
    return null;
  }
}

async function main() {
  const positions = loadPositions();

  if (positions.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          message: 'No open positions found',
          positions: [],
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    return;
  }

  const results = [];
  for (const pos of positions) {
    const current = await getCurrentPrice(pos.symbol);
    const pnlPercent = current ? ((current.price - pos.entryPrice) / pos.entryPrice) * 100 : null;

    results.push({
      ...pos,
      currentPrice: current?.price ?? pos.currentPrice,
      currentLiquidity: current?.liquidity ?? null,
      volume24h: current?.volume24h ?? null,
      priceChange24h: current?.priceChange24h ?? null,
      pnlPercent: pnlPercent ? parseFloat(pnlPercent.toFixed(2)) : null,
      alerts: {
        stopLossHit: current && current.price <= pos.stopLoss,
        downMoreThan20: pnlPercent !== null && pnlPercent < -20,
        liquidityLow: current && current.liquidity < 5000,
      },
    });

    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  const alerts = results.filter((r) => r.alerts.stopLossHit || r.alerts.downMoreThan20 || r.alerts.liquidityLow);

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        totalPositions: results.length,
        alertCount: alerts.length,
        positions: results,
        alerts: alerts.map((a) => ({
          symbol: a.symbol,
          reason: a.alerts.stopLossHit
            ? 'STOP_LOSS_HIT'
            : a.alerts.liquidityLow
              ? 'LOW_LIQUIDITY'
              : 'DOWN_MORE_THAN_20PCT',
          currentPrice: a.currentPrice,
          entryPrice: a.entryPrice,
          pnlPercent: a.pnlPercent,
        })),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  close();
}

main();
