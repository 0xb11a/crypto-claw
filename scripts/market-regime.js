#!/usr/bin/env node
/**
 * market-regime.js — Classify market regime and adjust trading parameters
 *
 * Fetches CoinGecko global data + Fear & Greed index, classifies the current
 * market regime (bullish/neutral/bearish/crisis), and stores it in portfolio_meta.
 *
 * Anti-whipsaw: regime only changes after 2 consecutive consistent readings.
 *
 * Usage:
 *   node scripts/market-regime.js
 *
 * Output: JSON with regime classification and adjusted parameters
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

// ============================================================
// Regime Classification
// ============================================================

const REGIMES = {
  bullish: {
    minCashReserve: 10,
    baseBuyingEnabled: true,
    maxMoonshotPosition: 5,
    maxConvictionPosition: 10,
    maxBasePosition: 50,
    maxMoonshotAllocation: 20,
    minBuyScore: 50,
  },
  neutral: {
    minCashReserve: 10,
    baseBuyingEnabled: true,
    maxMoonshotPosition: 5,
    maxConvictionPosition: 10,
    maxBasePosition: 50,
    maxMoonshotAllocation: 20,
    minBuyScore: 50,
  },
  bearish: {
    minCashReserve: 25,
    baseBuyingEnabled: false,
    maxMoonshotPosition: 3,
    maxConvictionPosition: 7,
    maxBasePosition: 50,
    maxMoonshotAllocation: 15,
    minBuyScore: 65,
  },
  crisis: {
    minCashReserve: 40,
    baseBuyingEnabled: false,
    maxMoonshotPosition: 0,
    maxConvictionPosition: 5,
    maxBasePosition: 50,
    maxMoonshotAllocation: 10,
    minBuyScore: 80,
  },
};

// Hard limits from AGENTS.md — regime can only tighten, never relax
const HARD_LIMITS = {
  minCashReserve: 10,       // regime can raise this, never lower
  maxMoonshotPosition: 5,   // regime can lower this, never raise
  maxConvictionPosition: 10, // regime can lower this, never raise
  maxBasePosition: 50,       // regime can lower this, never raise
  maxMoonshotAllocation: 20, // regime can lower this, never raise
};

/**
 * Classify regime based on Fear & Greed value and market cap change
 */
export function classifyRegime(fearGreedValue, marketCapChange24h) {
  if (fearGreedValue < 20 && marketCapChange24h < -5) return 'crisis';
  if (fearGreedValue < 40 && marketCapChange24h < 0) return 'bearish';
  if (fearGreedValue >= 60 && marketCapChange24h >= 0) return 'bullish';
  return 'neutral';
}

/**
 * Get regime adjustments — ensures they only tighten, never relax hard limits
 */
export function getRegimeAdjustments(regime) {
  const adjustments = { ...REGIMES[regime] };

  // Enforce: can only tighten, never relax
  adjustments.minCashReserve = Math.max(adjustments.minCashReserve, HARD_LIMITS.minCashReserve);
  adjustments.maxMoonshotPosition = Math.min(adjustments.maxMoonshotPosition, HARD_LIMITS.maxMoonshotPosition);
  adjustments.maxConvictionPosition = Math.min(adjustments.maxConvictionPosition, HARD_LIMITS.maxConvictionPosition);
  adjustments.maxBasePosition = Math.min(adjustments.maxBasePosition, HARD_LIMITS.maxBasePosition);
  adjustments.maxMoonshotAllocation = Math.min(adjustments.maxMoonshotAllocation, HARD_LIMITS.maxMoonshotAllocation);

  return { regime, ...adjustments };
}

/**
 * Anti-whipsaw: only transition after 2 consecutive consistent readings
 */
export function shouldTransition(currentRegime, newClassification, history) {
  if (currentRegime === newClassification) return false;
  if (!history || history.length === 0) return true; // first reading

  // Need 2 consecutive readings of the same new regime
  const lastReading = history[history.length - 1];
  return lastReading.regime === newClassification;
}

// ============================================================
// Main
// ============================================================

async function main() {
  try {
    // Fetch market data (same APIs as market-overview.js)
    const [globalRes, fgiRes] = await Promise.all([
      fetch('https://api.coingecko.com/api/v3/global'),
      fetch('https://api.alternative.me/fng/?limit=1'),
    ]);

    const globalData = await globalRes.json();
    const fgiData = await fgiRes.json();

    const global = globalData.data;
    const fgi = fgiData.data?.[0];

    const fearGreedValue = parseInt(fgi?.value ?? 50);
    const marketCapChange24h = parseFloat((global.market_cap_change_percentage_24h_usd ?? 0).toFixed(2));

    // Classify
    const newClassification = classifyRegime(fearGreedValue, marketCapChange24h);

    // Read current regime and history from DB
    const db = getDb();
    const currentRegimeRow = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'market_regime'").get();
    const historyRow = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'market_regime_history'").get();

    const currentRegime = currentRegimeRow?.value || 'neutral';
    let history = [];
    try {
      history = historyRow?.value ? JSON.parse(historyRow.value) : [];
    } catch { history = []; }

    // Anti-whipsaw check
    const transition = shouldTransition(currentRegime, newClassification, history);
    const effectiveRegime = transition ? newClassification : currentRegime;

    // Update history (keep last 10 readings for debugging)
    const reading = {
      regime: newClassification,
      fearGreed: fearGreedValue,
      marketCapChange24h,
      timestamp: new Date().toISOString(),
    };
    history.push(reading);
    if (history.length > 10) history = history.slice(-10);

    // Store to DB
    const upsert = db.prepare(`
      INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
    `);
    upsert.run('market_regime', effectiveRegime, effectiveRegime);
    upsert.run('market_regime_history', JSON.stringify(history), JSON.stringify(history));

    // Update heartbeat
    db.prepare("UPDATE heartbeat_state SET last_run = datetime('now') WHERE agent = 'research' AND check_type = 'market_regime'").run();

    close();

    // Build output
    const adjustments = getRegimeAdjustments(effectiveRegime);
    const output = {
      status: 'ok',
      regime: effectiveRegime,
      previousRegime: currentRegime,
      regimeChanged: transition,
      classification: newClassification,
      antiWhipsaw: !transition && newClassification !== currentRegime
        ? `Pending confirmation (need 2 consecutive ${newClassification} readings)`
        : null,
      inputs: {
        fearGreedValue,
        fearGreedClassification: fgi?.value_classification ?? 'Unknown',
        marketCapChange24h,
        totalMarketCap: global.total_market_cap?.usd ?? 0,
        btcDominance: parseFloat((global.market_cap_percentage?.btc ?? 0).toFixed(2)),
      },
      adjustments,
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }
}

main();
