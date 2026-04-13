#!/usr/bin/env node
/**
 * narrative-check.js — Check momentum of crypto narratives (26 narratives)
 *
 * Usage:
 *   node scripts/narrative-check.js                       # All narratives
 *   node scripts/narrative-check.js --narrative ai_infra  # Single narrative
 */

import 'dotenv/config';
import { log } from './log.js';
import { getDb, close } from './db.js';
import { NARRATIVES, getAllIds, getKeywordMap } from './narrative-config.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const KEYWORDS_PER_NARRATIVE = 2; // Search top N keywords per narrative

function parseArgs() {
  const args = process.argv.slice(2);
  let narrative = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--narrative') narrative = args[i + 1];
  }
  return { narrative };
}

async function fetchSearch(keyword) {
  const url = `${DEXSCREENER_BASE}/search?q=${encodeURIComponent(keyword)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`API ${res.status}`);
  return res.json();
}

async function checkNarrative(id, config) {
  const { keywords } = config;
  const searchKeywords = keywords.slice(0, KEYWORDS_PER_NARRATIVE);

  try {
    // Search top N keywords and merge results
    const allPairs = [];
    const seenPairs = new Set();

    for (const keyword of searchKeywords) {
      const data = await fetchSearch(keyword);
      for (const p of (data.pairs ?? []).slice(0, 15)) {
        if (!seenPairs.has(p.pairAddress)) {
          seenPairs.add(p.pairAddress);
          allPairs.push(p);
        }
      }
      if (searchKeywords.length > 1) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Take top 10 by volume
    const pairs = allPairs.sort((a, b) => parseFloat(b.volume?.h24 ?? 0) - parseFloat(a.volume?.h24 ?? 0)).slice(0, 10);

    const totalVolume = pairs.reduce((sum, p) => sum + parseFloat(p.volume?.h24 ?? 0), 0);
    const avgPriceChange =
      pairs.length > 0 ? pairs.reduce((sum, p) => sum + parseFloat(p.priceChange?.h24 ?? 0), 0) / pairs.length : 0;
    const totalLiquidity = pairs.reduce((sum, p) => sum + parseFloat(p.liquidity?.usd ?? 0), 0);

    return {
      narrative: id,
      narrativeName: config.name,
      category: config.category,
      tierAffinity: config.tierAffinity,
      status: 'ok',
      topTokens: pairs.length,
      totalVolume24h: parseFloat(totalVolume.toFixed(0)),
      avgPriceChange24h: parseFloat(avgPriceChange.toFixed(2)),
      totalLiquidity: parseFloat(totalLiquidity.toFixed(0)),
      momentum:
        avgPriceChange > 10 ? 'hot' : avgPriceChange > 0 ? 'warming' : avgPriceChange > -10 ? 'cooling' : 'cold',
      topPicks: pairs.slice(0, 3).map((p) => ({
        symbol: p.baseToken?.symbol,
        price: p.priceUsd,
        change24h: p.priceChange?.h24,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
      })),
    };
  } catch (err) {
    return {
      narrative: id,
      narrativeName: config.name,
      category: config.category,
      tierAffinity: config.tierAffinity,
      status: 'error',
      error: err.message,
    };
  }
}

/**
 * Detect narrative rotation within categories.
 * Rotation = one narrative in a category goes hot/warming while another cools/goes cold.
 */
function detectRotations(results) {
  const rotations = [];
  const byCategory = {};

  for (const r of results) {
    if (r.status !== 'ok') continue;
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  for (const [category, narratives] of Object.entries(byCategory)) {
    if (narratives.length < 2) continue;

    const rising = narratives.filter((n) => n.momentum === 'hot' || n.momentum === 'warming');
    const falling = narratives.filter((n) => n.momentum === 'cooling' || n.momentum === 'cold');

    // Rotation: capital flowing from falling → rising within same category
    for (const from of falling) {
      for (const to of rising) {
        if (from.narrative === to.narrative) continue;
        const confidence =
          from.momentum === 'cold' && to.momentum === 'hot'
            ? 'high'
            : (from.momentum === 'cooling' && to.momentum === 'hot') ||
                (from.momentum === 'cold' && to.momentum === 'warming')
              ? 'medium'
              : 'low';
        rotations.push({
          from: from.narrative,
          to: to.narrative,
          category,
          confidence,
          signal: `${from.narrativeName} (${from.momentum}) → ${to.narrativeName} (${to.momentum})`,
        });
      }
    }
  }

  // Only return medium/high confidence rotations
  return rotations.filter((r) => r.confidence !== 'low');
}

async function main() {
  const config = parseArgs();

  // Build narrative list to check
  let narrativesToCheck;
  if (config.narrative) {
    const n = NARRATIVES[config.narrative];
    if (!n) {
      log('warn', 'narrative-check', `Unknown narrative: ${config.narrative}`);
      console.error(`Unknown narrative: ${config.narrative}. Known: ${getAllIds().join(', ')}`);
      process.exit(1);
    }
    narrativesToCheck = { [config.narrative]: n };
  } else {
    narrativesToCheck = NARRATIVES;
  }

  const results = [];
  for (const [id, narrativeConfig] of Object.entries(narrativesToCheck)) {
    const result = await checkNarrative(id, narrativeConfig);
    results.push(result);
    await new Promise((r) => setTimeout(r, 300));
  }

  // Sort by momentum
  const sorted = results.sort((a, b) => {
    const order = { hot: 0, warming: 1, cooling: 2, cold: 3 };
    return (order[a.momentum] ?? 4) - (order[b.momentum] ?? 4);
  });

  const hottest = sorted.filter((n) => n.momentum === 'hot').map((n) => n.narrative);
  const warming = sorted.filter((n) => n.momentum === 'warming').map((n) => n.narrative);
  const cooling = sorted.filter((n) => n.momentum === 'cooling').map((n) => n.narrative);
  const cold = sorted.filter((n) => n.momentum === 'cold').map((n) => n.narrative);

  // Detect rotations (only for full scan)
  const rotations = !config.narrative ? detectRotations(sorted) : [];

  const result = {
    status: 'ok',
    narrativeCount: sorted.length,
    narratives: sorted,
    hottest,
    warming,
    cooling,
    cold,
    rotations,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  // Persist narrative momentum to DB (full scan only)
  if (!config.narrative) {
    try {
      const db = getDb();

      // Save current momentum
      const momentumData = JSON.stringify({
        hottest,
        warming,
        cooling,
        cold,
        keywords: getKeywordMap(),
        rotations,
        updated_at: result.timestamp,
      });
      db.prepare(
        `INSERT INTO portfolio_meta (key, value) VALUES ('narrative_momentum', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(momentumData);

      // Append to volume history (keep 7 days of 4-hourly readings)
      const historyRow = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'narrative_history'").get();
      let history = [];
      try {
        history = historyRow?.value ? JSON.parse(historyRow.value) : [];
      } catch {
        history = [];
      }

      const snapshot = {
        timestamp: result.timestamp,
        readings: sorted
          .filter((n) => n.status === 'ok')
          .map((n) => ({
            id: n.narrative,
            momentum: n.momentum,
            volume: n.totalVolume24h,
            avgChange: n.avgPriceChange24h,
          })),
      };
      history.push(snapshot);

      // Keep last 42 readings (~7 days at 4-hour cadence)
      if (history.length > 42) history = history.slice(-42);

      db.prepare(
        `INSERT INTO portfolio_meta (key, value) VALUES ('narrative_history', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
      ).run(JSON.stringify(history));

      close();
    } catch {
      /* DB write is best-effort — don't break the script */
    }
  }
}

main();
