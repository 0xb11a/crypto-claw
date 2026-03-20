#!/usr/bin/env node
/**
 * check-liquidity.js — Monitor liquidity changes for open positions
 *
 * Reads open positions from DB, fetches current liquidity from DEXScreener,
 * compares against previous snapshots in liquidity_snapshots table,
 * and writes new snapshots back.
 *
 * Usage:
 *   node scripts/check-liquidity.js
 *   node scripts/check-liquidity.js --chain base
 *   node scripts/check-liquidity.js --chain solana
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function loadPositions(db) {
  const isPaper = process.env.PAPER_MODE === 'true';
  const table = isPaper ? 'paper_positions' : 'positions';
  const chainFilter = getArg('chain');
  const query = chainFilter
    ? `SELECT * FROM ${table} WHERE status IN ('open', 'partial_exit') AND chain = ? ORDER BY created_at DESC`
    : `SELECT * FROM ${table} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`;
  return chainFilter ? db.prepare(query).all(chainFilter) : db.prepare(query).all();
}

function getPreviousSnapshot(db, address, chain) {
  return (
    db
      .prepare('SELECT * FROM liquidity_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT 1')
      .get(address, chain) || null
  );
}

function writeSnapshot(db, address, chain, liquidityUsd) {
  db.prepare('INSERT INTO liquidity_snapshots (address, chain, liquidity_usd) VALUES (?, ?, ?)').run(
    address,
    chain,
    liquidityUsd,
  );
}

async function getLiquidity(address) {
  try {
    const url = `${DEXSCREENER_BASE}/tokens/${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.sort((a, b) => parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0))[0];
    return pair
      ? {
          liquidity: parseFloat(pair.liquidity?.usd ?? 0),
          symbol: pair.baseToken?.symbol,
        }
      : null;
  } catch {
    return null;
  }
}

async function main() {
  const db = getDb();
  const positions = loadPositions(db);

  if (positions.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          message: 'No open positions to check liquidity for',
          tracked: 0,
          alertCount: 0,
          alerts: [],
          positions: {},
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    close();
    return;
  }

  const alerts = [];
  const updates = {};

  for (const pos of positions) {
    const current = await getLiquidity(pos.address);
    if (!current) continue;

    const prev = getPreviousSnapshot(db, pos.address, pos.chain);
    const change = prev ? ((current.liquidity - prev.liquidity_usd) / prev.liquidity_usd) * 100 : 0;

    // Write new snapshot to DB
    writeSnapshot(db, pos.address, pos.chain, current.liquidity);

    updates[pos.address] = {
      symbol: current.symbol ?? pos.symbol,
      chain: pos.chain,
      liquidity: current.liquidity,
      previousLiquidity: prev?.liquidity_usd ?? null,
      changePercent: parseFloat(change.toFixed(2)),
      lastChecked: new Date().toISOString(),
    };

    if (change < -30) {
      alerts.push({
        address: pos.address,
        symbol: current.symbol ?? pos.symbol,
        chain: pos.chain,
        severity: 'CRITICAL',
        type: 'LIQUIDITY_DRAIN',
        currentLiquidity: current.liquidity,
        previousLiquidity: prev?.liquidity_usd,
        changePercent: parseFloat(change.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change).toFixed(1)}% — possible rug`,
      });
    } else if (change < -15) {
      alerts.push({
        address: pos.address,
        symbol: current.symbol ?? pos.symbol,
        chain: pos.chain,
        severity: 'HIGH',
        type: 'LIQUIDITY_DECLINING',
        currentLiquidity: current.liquidity,
        previousLiquidity: prev?.liquidity_usd,
        changePercent: parseFloat(change.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change).toFixed(1)}%`,
      });
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        tracked: positions.length,
        alertCount: alerts.length,
        alerts,
        positions: updates,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  close();
}

main();
