#!/usr/bin/env node
/**
 * portfolio-summary.js — Calculate portfolio allocation and P&L
 *
 * Reads positions and cash from SQLite database (via db.js).
 *
 * Usage:
 *   node scripts/portfolio-summary.js
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function loadPortfolio() {
  try {
    const db = getDb();
    const isPaper = process.env.PAPER_MODE === 'true';

    if (isPaper) {
      const positions = db.prepare(
        "SELECT * FROM paper_positions WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC"
      ).all();
      const cash = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get()?.value || '10000');
      const totalDeposited = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance'").get()?.value || '10000');
      return { positions, cash, totalDeposited };
    }

    const positions = db.prepare(
      "SELECT * FROM positions WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC"
    ).all();
    const cash = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash'").get()?.value || '0');
    const totalDeposited = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'total_deposited'").get()?.value || '0');
    return { positions, cash, totalDeposited };
  } catch {
    return { positions: [], cash: 0, totalDeposited: 0 };
  }
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
      message: 'Empty portfolio. Set up positions via db-query.js add-position or deposit cash via set-cash.',
      timestamp: new Date().toISOString(),
    }, null, 2));
    close();
    return;
  }

  // Update current prices
  let totalPositionValue = 0;
  const positionDetails = [];

  for (const pos of portfolio.positions) {
    const currentPrice = await getCurrentPrice(pos.symbol) ?? pos.entry_price;
    const quantity = pos.quantity;
    const value = currentPrice * quantity;
    const pnl = ((currentPrice - pos.entry_price) / pos.entry_price * 100);

    totalPositionValue += value;
    positionDetails.push({
      id: pos.id,
      symbol: pos.symbol,
      address: pos.address,
      chain: pos.chain,
      tier: pos.tier,
      entryPrice: pos.entry_price,
      currentPrice,
      quantity,
      value: parseFloat(value.toFixed(2)),
      pnlPercent: parseFloat(pnl.toFixed(2)),
      pnlUsd: parseFloat((value - pos.entry_price * quantity).toFixed(2)),
      stopLoss: pos.stop_loss,
      status: pos.status,
    });

    await new Promise(r => setTimeout(r, 200));
  }

  const totalValue = totalPositionValue + portfolio.cash;
  const totalPnl = portfolio.totalDeposited > 0
    ? ((totalValue - portfolio.totalDeposited) / portfolio.totalDeposited * 100)
    : 0;

  // Calculate allocation by tier
  const allocation = { base: 0, conviction: 0, moonshot: 0, cash: portfolio.cash };
  for (const pos of positionDetails) {
    allocation[pos.tier] = (allocation[pos.tier] ?? 0) + pos.value;
  }

  const allocationPercent = {
    base: totalValue > 0 ? parseFloat((allocation.base / totalValue * 100).toFixed(1)) : 0,
    conviction: totalValue > 0 ? parseFloat((allocation.conviction / totalValue * 100).toFixed(1)) : 0,
    moonshot: totalValue > 0 ? parseFloat((allocation.moonshot / totalValue * 100).toFixed(1)) : 0,
    cash: totalValue > 0 ? parseFloat((allocation.cash / totalValue * 100).toFixed(1)) : 0,
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

  close();
}

main();
