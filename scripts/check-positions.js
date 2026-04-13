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
import { log } from './log.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function loadPositions() {
  try {
    const db = getDb();
    const isPaper = process.env.PAPER_MODE === 'true';
    const table = isPaper ? 'paper_positions' : 'positions';
    const rows = db
      .prepare(`SELECT * FROM ${table} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`)
      .all();
    return rows.map((r) => {
      let takeProfitLevels = [];
      try {
        takeProfitLevels = r.take_profit_levels ? JSON.parse(r.take_profit_levels) : [];
      } catch (e) {
        log(
          'warn',
          'check-positions',
          `Failed to parse take_profit_levels for position ${r.id} (${r.symbol}): ${e.message}`,
        );
        takeProfitLevels = [];
      }
      let tpLevelsHit = [];
      try {
        tpLevelsHit = r.tp_levels_hit ? JSON.parse(r.tp_levels_hit) : [];
      } catch (e) {
        log(
          'warn',
          'check-positions',
          `Failed to parse tp_levels_hit for position ${r.id} (${r.symbol}): ${e.message}`,
        );
        tpLevelsHit = [];
      }
      return {
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
        takeProfitLevels,
        maxPriceSinceEntry: r.max_price_since_entry ?? null,
        trailingStopPct: r.trailing_stop_pct ?? null,
        trailingStopActive: r.trailing_stop_active === 1,
        tpLevelsHit,
        status: r.status,
      };
    });
  } catch (e) {
    log('warn', 'check-positions', `Failed to load positions from DB: ${e.message}`);
    return [];
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
    return best
      ? {
          price: parseFloat(best.priceUsd ?? 0),
          liquidity: parseFloat(best.liquidity?.usd ?? 0),
          volume24h: parseFloat(best.volume?.h24 ?? 0),
          priceChange24h: parseFloat(best.priceChange?.h24 ?? 0),
        }
      : null;
  } catch (e) {
    log('warn', 'check-positions', `Price fetch failed for ${address} on ${chain}: ${e.message}`);
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
    const current = await getCurrentPrice(pos.address, pos.chain);
    if (!current) {
      log(
        'warn',
        'check-positions',
        `No price data for ${pos.symbol} (${pos.address}) on ${pos.chain} — alerts will not fire`,
      );
    }
    const currentPrice = current?.price ?? pos.currentPrice;
    const pnlPercent = current ? ((current.price - pos.entryPrice) / pos.entryPrice) * 100 : null;
    const pnlMultiple = current ? current.price / pos.entryPrice : null;

    // Detect TP hits — check each untriggered level
    const takeProfitHits = [];
    if (current && pos.takeProfitLevels.length > 0) {
      for (const tp of pos.takeProfitLevels) {
        const alreadyHit = tp.triggered || pos.tpLevelsHit.includes(tp.level);
        if (!alreadyHit && current.price >= tp.price) {
          takeProfitHits.push({
            level: tp.level,
            price: tp.price,
            sellPercent: tp.sellPercent,
            multiplier: tp.multiplier ?? null,
          });
        }
      }
    }

    // Detect trailing stop trigger
    const maxPrice = pos.maxPriceSinceEntry ?? pos.entryPrice;
    const newMaxPrice = current ? Math.max(maxPrice, current.price) : maxPrice;
    let trailingStopHit = false;
    if (pos.trailingStopActive && pos.trailingStopPct && current) {
      const trailingThreshold = newMaxPrice * (1 - pos.trailingStopPct / 100);
      trailingStopHit = current.price < trailingThreshold;
    }

    results.push({
      ...pos,
      currentPrice,
      currentLiquidity: current?.liquidity ?? null,
      volume24h: current?.volume24h ?? null,
      priceChange24h: current?.priceChange24h ?? null,
      pnlPercent: pnlPercent !== null ? parseFloat(pnlPercent.toFixed(2)) : null,
      pnlMultiple: pnlMultiple !== null ? parseFloat(pnlMultiple.toFixed(2)) : null,
      maxPriceSinceEntry: newMaxPrice,
      alerts: {
        stopLossHit: current && current.price <= pos.stopLoss,
        takeProfitHits,
        trailingStopHit,
        downMoreThan20: pnlPercent !== null && pnlPercent < -20,
        liquidityLow: current && current.liquidity < 5000,
      },
    });

    // Rate limit
    await new Promise((r) => setTimeout(r, 200));
  }

  const alerts = results.filter(
    (r) =>
      r.alerts.stopLossHit ||
      r.alerts.takeProfitHits.length > 0 ||
      r.alerts.trailingStopHit ||
      r.alerts.downMoreThan20 ||
      r.alerts.liquidityLow,
  );

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        totalPositions: results.length,
        alertCount: alerts.length,
        positions: results,
        alerts: alerts.map((a) => {
          let reason = 'DOWN_MORE_THAN_20PCT';
          if (a.alerts.stopLossHit) reason = 'STOP_LOSS_HIT';
          else if (a.alerts.trailingStopHit) reason = 'TRAILING_STOP_HIT';
          else if (a.alerts.takeProfitHits.length > 0) reason = `TP${a.alerts.takeProfitHits[0].level}_HIT`;
          else if (a.alerts.liquidityLow) reason = 'LOW_LIQUIDITY';
          return {
            symbol: a.symbol,
            reason,
            currentPrice: a.currentPrice,
            entryPrice: a.entryPrice,
            pnlPercent: a.pnlPercent,
            pnlMultiple: a.pnlMultiple,
            takeProfitHits: a.alerts.takeProfitHits.length > 0 ? a.alerts.takeProfitHits : undefined,
          };
        }),
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  close();
}

main();
