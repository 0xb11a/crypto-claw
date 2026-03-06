#!/usr/bin/env node
/**
 * check-liquidity.js — Monitor liquidity changes for open positions
 *
 * Usage:
 *   node scripts/check-liquidity.js
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const STATE_FILE = resolve(process.cwd(), 'workspace/memory/liquidity-state.json');

function loadState() {
  if (!existsSync(STATE_FILE)) return {};
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

async function getLiquidity(address) {
  try {
    const url = `${DEXSCREENER_BASE}/tokens/${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.sort((a, b) =>
      parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0)
    )[0];
    return pair ? {
      liquidity: parseFloat(pair.liquidity?.usd ?? 0),
      symbol: pair.baseToken?.symbol,
    } : null;
  } catch {
    return null;
  }
}

async function main() {
  // Read positions from memory — this is a simplified version
  // In production, positions would be tracked in a proper state file
  const state = loadState();
  const trackedTokens = Object.keys(state);

  if (trackedTokens.length === 0) {
    console.log(JSON.stringify({
      status: 'ok',
      message: 'No tokens being tracked for liquidity. Add tokens to liquidity-state.json.',
      timestamp: new Date().toISOString(),
    }, null, 2));
    return;
  }

  const alerts = [];
  const updates = {};

  for (const address of trackedTokens) {
    const current = await getLiquidity(address);
    if (!current) continue;

    const prev = state[address];
    const change = prev?.liquidity
      ? ((current.liquidity - prev.liquidity) / prev.liquidity * 100)
      : 0;

    updates[address] = {
      symbol: current.symbol ?? prev?.symbol ?? 'unknown',
      liquidity: current.liquidity,
      previousLiquidity: prev?.liquidity ?? null,
      changePercent: parseFloat(change.toFixed(2)),
      lastChecked: new Date().toISOString(),
    };

    if (change < -30) {
      alerts.push({
        address,
        symbol: current.symbol,
        severity: 'CRITICAL',
        type: 'LIQUIDITY_DRAIN',
        currentLiquidity: current.liquidity,
        previousLiquidity: prev?.liquidity,
        changePercent: parseFloat(change.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change).toFixed(1)}% — possible rug`,
      });
    } else if (change < -15) {
      alerts.push({
        address,
        symbol: current.symbol,
        severity: 'HIGH',
        type: 'LIQUIDITY_DECLINING',
        currentLiquidity: current.liquidity,
        previousLiquidity: prev?.liquidity,
        changePercent: parseFloat(change.toFixed(2)),
        message: `Liquidity dropped ${Math.abs(change).toFixed(1)}%`,
      });
    }

    await new Promise(r => setTimeout(r, 200));
  }

  saveState(updates);

  console.log(JSON.stringify({
    status: 'ok',
    tracked: trackedTokens.length,
    alertCount: alerts.length,
    alerts,
    positions: updates,
    timestamp: new Date().toISOString(),
  }, null, 2));
}

main();
