#!/usr/bin/env node
/**
 * portfolio-summary.js — Calculate portfolio allocation and P&L
 *
 * Usage:
 *   node scripts/portfolio-summary.js
 */

import 'dotenv/config';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

// Read portfolio from MEMORY.md or a dedicated state file
function loadPortfolio() {
  const stateFile = resolve(process.cwd(), 'workspace/memory/portfolio-state.json');
  if (existsSync(stateFile)) {
    try {
      return JSON.parse(readFileSync(stateFile, 'utf-8'));
    } catch {
      return { positions: [], cash: 0, totalDeposited: 0 };
    }
  }
  return { positions: [], cash: 0, totalDeposited: 0 };
}

async function getCurrentPrice(symbol) {
  try {
    const url = `${DEXSCREENER_BASE}/search?q=${symbol}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    return parseFloat(data.pairs?.[0]?.priceUsd ?? 0);
  } catch {
    return null;
  }
}

async function main() {
  const portfolio = loadPortfolio();

  if (portfolio.positions.length === 0 && portfolio.cash === 0) {
    console.log(JSON.stringify({
      status: 'ok',
      message: 'Empty portfolio. Initialize by creating workspace/memory/portfolio-state.json',
      example: {
        positions: [
          {
            symbol: 'TOKEN',
            address: '0x...',
            chain: 'ethereum',
            entryPrice: 0.001,
            quantity: 10000,
            tier: 'moonshot',
            stopLoss: 0.0005,
            takeProfitLevels: [
              { multiplier: 2, sellPercent: 50 },
              { multiplier: 5, sellPercent: 30 },
              { multiplier: 10, sellPercent: 15 },
            ],
            entryDate: '2026-03-01',
          }
        ],
        cash: 5000,
        totalDeposited: 10000,
      },
      timestamp: new Date().toISOString(),
    }, null, 2));
    return;
  }

  // Update current prices
  let totalPositionValue = 0;
  const positionDetails = [];

  for (const pos of portfolio.positions) {
    const currentPrice = await getCurrentPrice(pos.symbol) ?? pos.entryPrice;
    const value = currentPrice * pos.quantity;
    const pnl = ((currentPrice - pos.entryPrice) / pos.entryPrice * 100);

    totalPositionValue += value;
    positionDetails.push({
      ...pos,
      currentPrice,
      value: parseFloat(value.toFixed(2)),
      pnlPercent: parseFloat(pnl.toFixed(2)),
      pnlUsd: parseFloat((value - pos.entryPrice * pos.quantity).toFixed(2)),
    });

    await new Promise(r => setTimeout(r, 200));
  }

  const totalValue = totalPositionValue + portfolio.cash;
  const totalPnl = ((totalValue - portfolio.totalDeposited) / portfolio.totalDeposited * 100);

  // Calculate allocation by tier
  const allocation = { base: 0, conviction: 0, moonshot: 0, cash: portfolio.cash };
  for (const pos of positionDetails) {
    allocation[pos.tier] = (allocation[pos.tier] ?? 0) + pos.value;
  }

  const allocationPercent = {
    base: parseFloat((allocation.base / totalValue * 100).toFixed(1)),
    conviction: parseFloat((allocation.conviction / totalValue * 100).toFixed(1)),
    moonshot: parseFloat((allocation.moonshot / totalValue * 100).toFixed(1)),
    cash: parseFloat((allocation.cash / totalValue * 100).toFixed(1)),
  };

  // Check allocation health
  const allocationAlerts = [];
  if (allocationPercent.moonshot > 20) allocationAlerts.push('Moonshot allocation exceeds 20% target');
  if (allocationPercent.cash < 10) allocationAlerts.push('Cash reserve below 10% minimum');

  console.log(JSON.stringify({
    status: 'ok',
    summary: {
      totalValue: parseFloat(totalValue.toFixed(2)),
      totalDeposited: portfolio.totalDeposited,
      totalPnlPercent: parseFloat(totalPnl.toFixed(2)),
      totalPnlUsd: parseFloat((totalValue - portfolio.totalDeposited).toFixed(2)),
      positionCount: positionDetails.length,
      cashBalance: portfolio.cash,
    },
    allocation: allocationPercent,
    allocationAlerts,
    positions: positionDetails,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main();
