#!/usr/bin/env node
/**
 * narrative-check.js — Check momentum of crypto narratives
 *
 * Usage:
 *   node scripts/narrative-check.js --narrative ai
 *   node scripts/narrative-check.js (checks all narratives)
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

const NARRATIVE_KEYWORDS = {
  ai: ['AI', 'GPT', 'neural', 'agent', 'machine learning'],
  rwa: ['RWA', 'real world', 'tokenized', 'treasury'],
  depin: ['DePIN', 'IoT', 'infrastructure', 'network'],
  memecoin: ['PEPE', 'DOGE', 'SHIB', 'meme', 'WIF'],
  gaming: ['game', 'play', 'metaverse', 'NFT game'],
  defi: ['swap', 'lend', 'yield', 'DEX', 'lending'],
  l2: ['layer 2', 'L2', 'rollup', 'scaling'],
  socialfi: ['social', 'SocialFi', 'creator', 'content'],
};

function parseArgs() {
  const args = process.argv.slice(2);
  let narrative = null;
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--narrative') narrative = args[i + 1];
  }
  return { narrative };
}

async function checkNarrative(name, keywords) {
  const results = [];
  // Search for top keyword
  const keyword = keywords[0];
  try {
    const url = `${DEXSCREENER_BASE}/search?q=${keyword}`;
    const res = await fetch(url);
    if (!res.ok) return { narrative: name, status: 'error', error: `API ${res.status}` };
    const data = await res.json();

    const pairs = (data.pairs ?? []).slice(0, 10);
    const totalVolume = pairs.reduce((sum, p) => sum + parseFloat(p.volume?.h24 ?? 0), 0);
    const avgPriceChange = pairs.length > 0
      ? pairs.reduce((sum, p) => sum + parseFloat(p.priceChange?.h24 ?? 0), 0) / pairs.length
      : 0;
    const totalLiquidity = pairs.reduce((sum, p) => sum + parseFloat(p.liquidity?.usd ?? 0), 0);

    return {
      narrative: name,
      status: 'ok',
      topTokens: pairs.length,
      totalVolume24h: parseFloat(totalVolume.toFixed(0)),
      avgPriceChange24h: parseFloat(avgPriceChange.toFixed(2)),
      totalLiquidity: parseFloat(totalLiquidity.toFixed(0)),
      momentum: avgPriceChange > 10 ? 'hot' : avgPriceChange > 0 ? 'warming' : avgPriceChange > -10 ? 'cooling' : 'cold',
      topPicks: pairs.slice(0, 3).map(p => ({
        symbol: p.baseToken?.symbol,
        price: p.priceUsd,
        change24h: p.priceChange?.h24,
        volume24h: p.volume?.h24,
        liquidity: p.liquidity?.usd,
      })),
    };
  } catch (err) {
    return { narrative: name, status: 'error', error: err.message };
  }
}

async function main() {
  const config = parseArgs();

  const narratives = config.narrative
    ? { [config.narrative]: NARRATIVE_KEYWORDS[config.narrative] ?? [config.narrative] }
    : NARRATIVE_KEYWORDS;

  const results = [];
  for (const [name, keywords] of Object.entries(narratives)) {
    const result = await checkNarrative(name, keywords);
    results.push(result);
    await new Promise(r => setTimeout(r, 300));
  }

  // Sort by momentum
  const sorted = results.sort((a, b) => {
    const order = { hot: 0, warming: 1, cooling: 2, cold: 3 };
    return (order[a.momentum] ?? 4) - (order[b.momentum] ?? 4);
  });

  const result = {
    status: 'ok',
    narratives: sorted,
    hottest: sorted.filter(n => n.momentum === 'hot').map(n => n.narrative),
    warming: sorted.filter(n => n.momentum === 'warming').map(n => n.narrative),
    cooling: sorted.filter(n => n.momentum === 'cooling').map(n => n.narrative),
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(result, null, 2));

  // Persist narrative momentum to DB so other scripts (e.g. scan-tokens --sort established) can use it
  if (!config.narrative) {
    try {
      const db = getDb();
      const data = JSON.stringify({
        hottest: result.hottest,
        warming: result.warming,
        cooling: result.cooling,
        keywords: NARRATIVE_KEYWORDS,
        updated_at: result.timestamp,
      });
      db.prepare(`
        INSERT INTO portfolio_meta (key, value) VALUES ('narrative_momentum', ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
      `).run(data);
      close();
    } catch { /* DB write is best-effort — don't break the script */ }
  }
}

main();
