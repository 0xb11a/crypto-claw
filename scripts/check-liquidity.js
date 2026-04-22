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
import { log } from './log.js';

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

function getOldestInWindow(db, address, chain, hours) {
  return (
    db
      .prepare(
        `SELECT * FROM liquidity_snapshots
         WHERE address = ? AND chain = ?
           AND checked_at >= datetime('now', ?)
         ORDER BY checked_at ASC LIMIT 1`,
      )
      .get(address, chain, `-${hours} hours`) || null
  );
}

function pctChange(current, previous) {
  if (!previous || previous <= 0) return null;
  return ((current - previous) / previous) * 100;
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
  } catch (e) {
    log('warn', 'check-liquidity', `Liquidity fetch failed for ${address}: ${e.message}`);
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
    if (!current) {
      log(
        'warn',
        'check-liquidity',
        `Skipping position ${pos.symbol} (${pos.address}) on ${pos.chain} — liquidity fetch returned null`,
      );
      continue;
    }

    const ref1h = getOldestInWindow(db, pos.address, pos.chain, 1);
    const ref24h = getOldestInWindow(db, pos.address, pos.chain, 24);
    const change1h = ref1h ? pctChange(current.liquidity, ref1h.liquidity_usd) : null;
    const change24h = ref24h ? pctChange(current.liquidity, ref24h.liquidity_usd) : null;

    writeSnapshot(db, pos.address, pos.chain, current.liquidity);

    updates[pos.address] = {
      symbol: current.symbol ?? pos.symbol,
      chain: pos.chain,
      liquidity: current.liquidity,
      reference1h: ref1h
        ? {
            liquidity: ref1h.liquidity_usd,
            checkedAt: ref1h.checked_at,
            changePercent: change1h !== null ? parseFloat(change1h.toFixed(2)) : null,
          }
        : null,
      reference24h: ref24h
        ? {
            liquidity: ref24h.liquidity_usd,
            checkedAt: ref24h.checked_at,
            changePercent: change24h !== null ? parseFloat(change24h.toFixed(2)) : null,
          }
        : null,
      lastChecked: new Date().toISOString(),
    };

    if (change1h !== null && change1h < -30) {
      alerts.push({
        address: pos.address,
        symbol: current.symbol ?? pos.symbol,
        chain: pos.chain,
        severity: 'CRITICAL',
        type: 'LIQUIDITY_DRAIN',
        window: '1h',
        currentLiquidity: current.liquidity,
        referenceLiquidity: ref1h.liquidity_usd,
        referenceCheckedAt: ref1h.checked_at,
        changePercent: parseFloat(change1h.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change1h).toFixed(1)}% in 1h — possible rug`,
      });
    } else if (change24h !== null && change24h < -15) {
      alerts.push({
        address: pos.address,
        symbol: current.symbol ?? pos.symbol,
        chain: pos.chain,
        severity: 'HIGH',
        type: 'LIQUIDITY_DECLINING',
        window: '24h',
        currentLiquidity: current.liquidity,
        referenceLiquidity: ref24h.liquidity_usd,
        referenceCheckedAt: ref24h.checked_at,
        changePercent: parseFloat(change24h.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change24h).toFixed(1)}% in 24h`,
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
