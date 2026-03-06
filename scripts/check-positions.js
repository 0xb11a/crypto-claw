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
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function loadPositions() {
  // Try to read positions from MEMORY.md portfolio state
  const memoryPath = resolve(process.cwd(), 'workspace/MEMORY.md');
  if (!existsSync(memoryPath)) {
    return [];
  }

  const content = readFileSync(memoryPath, 'utf-8');

  // Parse the portfolio state table
  const tableMatch = content.match(/## Portfolio State\n\n\|.*\n\|.*\n([\s\S]*?)(?=\n##|\n$|$)/);
  if (!tableMatch) return [];

  const rows = tableMatch[1].trim().split('\n').filter(r => !r.includes('*no positions'));
  const positions = [];

  for (const row of rows) {
    const cols = row.split('|').map(c => c.trim()).filter(Boolean);
    if (cols.length >= 7) {
      positions.push({
        symbol: cols[0],
        chain: cols[1],
        entryPrice: parseFloat(cols[2].replace('$', '')),
        currentPrice: parseFloat(cols[3].replace('$', '')),
        sizePercent: parseFloat(cols[4].replace('%', '')),
        tier: cols[5],
        stopLoss: parseFloat(cols[6].replace('$', '')),
        status: cols[7] ?? 'open',
      });
    }
  }

  return positions;
}

async function getCurrentPrice(symbol) {
  try {
    const url = `${DEXSCREENER_BASE}/search?q=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    return pair ? {
      price: parseFloat(pair.priceUsd ?? 0),
      liquidity: parseFloat(pair.liquidity?.usd ?? 0),
      volume24h: parseFloat(pair.volume?.h24 ?? 0),
      priceChange24h: parseFloat(pair.priceChange?.h24 ?? 0),
    } : null;
  } catch {
    return null;
  }
}

async function main() {
  const positions = loadPositions();

  if (positions.length === 0) {
    console.log(JSON.stringify({
      status: 'ok',
      message: 'No open positions found',
      positions: [],
      timestamp: new Date().toISOString(),
    }, null, 2));
    return;
  }

  const results = [];
  for (const pos of positions) {
    const current = await getCurrentPrice(pos.symbol);
    const pnlPercent = current
      ? ((current.price - pos.entryPrice) / pos.entryPrice * 100)
      : null;

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
    await new Promise(r => setTimeout(r, 200));
  }

  const alerts = results.filter(r => r.alerts.stopLossHit || r.alerts.downMoreThan20 || r.alerts.liquidityLow);

  console.log(JSON.stringify({
    status: 'ok',
    totalPositions: results.length,
    alertCount: alerts.length,
    positions: results,
    alerts: alerts.map(a => ({
      symbol: a.symbol,
      reason: a.alerts.stopLossHit ? 'STOP_LOSS_HIT'
        : a.alerts.liquidityLow ? 'LOW_LIQUIDITY'
        : 'DOWN_MORE_THAN_20PCT',
      currentPrice: a.currentPrice,
      entryPrice: a.entryPrice,
      pnlPercent: a.pnlPercent,
    })),
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main();
