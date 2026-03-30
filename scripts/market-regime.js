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
  // Bullish/neutral: no tightening — null means "use chain default"
  // Caller applies min(chainRule, regimeLimit) so null = no regime constraint
  bullish: {
    minCashReserve: null,
    baseBuyingEnabled: true,
    maxMoonshotPosition: null,
    maxConvictionPosition: null,
    maxBasePosition: null,
    maxMoonshotAllocation: null,
    minBuyScore: 50,
  },
  neutral: {
    minCashReserve: null,
    baseBuyingEnabled: true,
    maxMoonshotPosition: null,
    maxConvictionPosition: null,
    maxBasePosition: null,
    maxMoonshotAllocation: null,
    minBuyScore: 50,
  },
  bearish: {
    minCashReserve: 25,
    baseBuyingEnabled: false,
    maxMoonshotPosition: 3,
    maxConvictionPosition: 7,
    maxBasePosition: 30,
    maxMoonshotAllocation: 20,
    minBuyScore: 65,
  },
  crisis: {
    minCashReserve: 40,
    baseBuyingEnabled: false,
    maxMoonshotPosition: 0,
    maxConvictionPosition: 5,
    maxBasePosition: 30,
    maxMoonshotAllocation: 10,
    minBuyScore: 80,
  },
};

// Global defaults from chains.js PORTFOLIO_RULES — used as fallback when regime returns null
import { PORTFOLIO_RULES } from './chains.js';
const GLOBAL_DEFAULTS = {
  minCashReserve: PORTFOLIO_RULES.minCashReserve,
  maxMoonshotPosition: PORTFOLIO_RULES.maxMoonshotPosition,
  maxConvictionPosition: PORTFOLIO_RULES.maxConvictionPosition,
  maxBasePosition: PORTFOLIO_RULES.maxBasePosition,
  maxMoonshotAllocation: PORTFOLIO_RULES.maxMoonshotAllocation,
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
 * Get regime adjustments.
 * Null values mean "no regime constraint" — caller uses chain default via min(chainRule, regimeLimit).
 * Non-null values are clamped against global defaults so regime can only tighten.
 */
export function getRegimeAdjustments(regime) {
  const raw = { ...REGIMES[regime] };
  const adjustments = {};

  // For each limit: null = use chain default, non-null = clamp so regime only tightens
  adjustments.minCashReserve =
    raw.minCashReserve != null
      ? Math.max(raw.minCashReserve, GLOBAL_DEFAULTS.minCashReserve)
      : GLOBAL_DEFAULTS.minCashReserve;
  adjustments.maxMoonshotPosition =
    raw.maxMoonshotPosition != null ? Math.min(raw.maxMoonshotPosition, GLOBAL_DEFAULTS.maxMoonshotPosition) : null;
  adjustments.maxConvictionPosition =
    raw.maxConvictionPosition != null
      ? Math.min(raw.maxConvictionPosition, GLOBAL_DEFAULTS.maxConvictionPosition)
      : null;
  adjustments.maxBasePosition =
    raw.maxBasePosition != null ? Math.min(raw.maxBasePosition, GLOBAL_DEFAULTS.maxBasePosition) : null;
  adjustments.maxMoonshotAllocation =
    raw.maxMoonshotAllocation != null
      ? Math.min(raw.maxMoonshotAllocation, GLOBAL_DEFAULTS.maxMoonshotAllocation)
      : null;

  adjustments.baseBuyingEnabled = raw.baseBuyingEnabled;
  adjustments.minBuyScore = raw.minBuyScore;

  return { regime, ...adjustments };
}

// ============================================================
// Exit Adjustments — regime-aware TP/SL modifiers
// Applied at order creation time (baked into position at entry)
// ============================================================

const EXIT_ADJUSTMENTS = {
  bullish: { tpMultiplier: 1.2, slTightenPct: 0, sellPctAdjust: -10, timeStopDays: 2 },
  neutral: { tpMultiplier: 1.0, slTightenPct: 0, sellPctAdjust: 0, timeStopDays: 0 },
  bearish: { tpMultiplier: 0.8, slTightenPct: 10, sellPctAdjust: 5, timeStopDays: -1 },
  crisis: { tpMultiplier: 0.6, slTightenPct: 20, sellPctAdjust: 10, timeStopDays: -2 },
};

/**
 * Get exit adjustments for a regime.
 * tpMultiplier: multiply baseline TP targets (e.g., 2x * 1.2 = 2.4x in bullish)
 * slTightenPct: tighten SL by this % (e.g., -45% baseline * 10% = -40.5% in bearish)
 * sellPctAdjust: add to sell percentages at each TP level (clamped 5-90%)
 * timeStopDays: add/subtract from time stop days
 */
export function getExitAdjustments(regime) {
  return { regime, ...(EXIT_ADJUSTMENTS[regime] || EXIT_ADJUSTMENTS.neutral) };
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
    } catch {
      history = [];
    }

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
    db.prepare(
      "UPDATE heartbeat_state SET last_run = datetime('now') WHERE agent = 'research' AND check_type = 'market_regime'",
    ).run();

    close();

    // Build output
    const adjustments = getRegimeAdjustments(effectiveRegime);
    const output = {
      status: 'ok',
      regime: effectiveRegime,
      previousRegime: currentRegime,
      regimeChanged: transition,
      classification: newClassification,
      antiWhipsaw:
        !transition && newClassification !== currentRegime
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
      exitAdjustments: getExitAdjustments(effectiveRegime),
      timestamp: new Date().toISOString(),
    };

    console.log(JSON.stringify(output, null, 2));
  } catch (err) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: err.message,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }
}

main();
