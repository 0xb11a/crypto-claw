#!/usr/bin/env node
/**
 * portfolio-summary.js — Calculate portfolio allocation and P&L
 *
 * Reads positions and cash from SQLite database (via db.js).
 * Supports per-chain filtering with --chain flag.
 *
 * Usage:
 *   node scripts/portfolio-summary.js
 *   node scripts/portfolio-summary.js --chain base
 *   node scripts/portfolio-summary.js --chain solana
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getAllChains, getPortfolioRules } from './chains.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: null };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--chain') config.chain = args[i + 1];
  }
  return config;
}

function loadPortfolio(chain) {
  try {
    const db = getDb();
    const isPaper = process.env.PAPER_MODE === 'true';

    if (chain) {
      const posTable = isPaper ? 'paper_positions' : 'positions';
      const cashPrefix = isPaper ? 'paper_cash_' : 'cash_';
      const depositedPrefix = isPaper ? 'paper_initial_balance_' : 'total_deposited_';

      const positions = db
        .prepare(
          `SELECT * FROM ${posTable} WHERE chain = ? AND status IN ('open', 'partial_exit') ORDER BY created_at DESC`,
        )
        .all(chain);
      const cash = parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`${cashPrefix}${chain}`)?.value || '0',
      );
      const totalDeposited = parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`${depositedPrefix}${chain}`)?.value || '0',
      );
      return { positions, cash, totalDeposited };
    }

    // No chain filter — sum all chains
    const posTable = isPaper ? 'paper_positions' : 'positions';
    const positions = db
      .prepare(`SELECT * FROM ${posTable} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`)
      .all();

    let cash = 0;
    let totalDeposited = 0;
    const cashPrefix = isPaper ? 'paper_cash_' : 'cash_';
    const depositedPrefix = isPaper ? 'paper_initial_balance_' : 'total_deposited_';
    for (const c of getAllChains()) {
      cash += parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`${cashPrefix}${c}`)?.value || '0',
      );
      totalDeposited += parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`${depositedPrefix}${c}`)?.value || '0',
      );
    }
    return { positions, cash, totalDeposited };
  } catch {
    return { positions: [], cash: 0, totalDeposited: 0 };
  }
}

async function getCurrentPrice(address, chain) {
  try {
    const url = `${DEXSCREENER_BASE}/tokens/${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    const chainPairs = pairs.filter((p) => p.chainId === chain);
    const best = (chainPairs.length > 0 ? chainPairs : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];
    return best ? parseFloat(best.priceUsd ?? 0) : null;
  } catch {
    return null;
  }
}

async function main() {
  const { chain } = parseArgs();
  const portfolio = loadPortfolio(chain);

  if (portfolio.positions.length === 0 && portfolio.cash === 0) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          message: 'Empty portfolio. Set up positions via db-query.js add-position or deposit cash via set-cash.',
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    close();
    return;
  }

  // Update current prices
  let totalPositionValue = 0;
  const positionDetails = [];

  for (const pos of portfolio.positions) {
    const currentPrice = (await getCurrentPrice(pos.address, pos.chain)) ?? pos.entry_price;
    const quantity = pos.quantity;
    const value = currentPrice * quantity;
    const pnl = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;

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

    await new Promise((r) => setTimeout(r, 200));
  }

  const totalValue = totalPositionValue + portfolio.cash;
  const totalPnl =
    portfolio.totalDeposited > 0 ? ((totalValue - portfolio.totalDeposited) / portfolio.totalDeposited) * 100 : 0;

  // Calculate allocation by tier
  const allocation = { base: 0, conviction: 0, moonshot: 0, cash: portfolio.cash };
  for (const pos of positionDetails) {
    allocation[pos.tier] = (allocation[pos.tier] ?? 0) + pos.value;
  }

  const allocationPercent = {
    base: totalValue > 0 ? parseFloat(((allocation.base / totalValue) * 100).toFixed(1)) : 0,
    conviction: totalValue > 0 ? parseFloat(((allocation.conviction / totalValue) * 100).toFixed(1)) : 0,
    moonshot: totalValue > 0 ? parseFloat(((allocation.moonshot / totalValue) * 100).toFixed(1)) : 0,
    cash: totalValue > 0 ? parseFloat(((allocation.cash / totalValue) * 100).toFixed(1)) : 0,
  };

  // Check allocation health — use per-chain rules if chain specified
  const allocationAlerts = [];
  if (chain) {
    const rules = getPortfolioRules(chain);
    if (allocationPercent.moonshot > rules.maxMoonshotAllocation)
      allocationAlerts.push(`Moonshot allocation exceeds ${rules.maxMoonshotAllocation}% target`);
    if (allocationPercent.cash < rules.minCashReserve)
      allocationAlerts.push(`Cash reserve below ${rules.minCashReserve}% minimum`);
  } else {
    if (allocationPercent.moonshot > 20) allocationAlerts.push('Moonshot allocation exceeds 20% target');
    if (allocationPercent.cash < 10) allocationAlerts.push('Cash reserve below 10% minimum');
  }

  const result = {
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
  };
  if (chain) result.chain = chain;

  console.log(JSON.stringify(result, null, 2));

  close();
}

main();
