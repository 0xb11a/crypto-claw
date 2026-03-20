#!/usr/bin/env node
/**
 * scan-tokens.js — Scan DEXScreener for trending/new tokens
 *
 * Usage:
 *   node scripts/scan-tokens.js --chain solana --sort trending --limit 20
 *   node scripts/scan-tokens.js --chain base --sort newest --min-liquidity 10000
 *   node scripts/scan-tokens.js --chain all --sort established --min-liquidity 100000 --limit 30
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { isActive } from './chains.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com';
const DEXSCREENER_DEX = `${DEXSCREENER_BASE}/latest/dex`;
const CACHE = new Map();
const CACHE_TTL = 60_000; // 60 seconds

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: 'all', sort: 'trending', limit: 20, minLiquidity: 5000 };
  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--chain':
        config.chain = args[i + 1];
        break;
      case '--sort':
        config.sort = args[i + 1];
        break;
      case '--limit':
        config.limit = parseInt(args[i + 1]);
        break;
      case '--min-liquidity':
        config.minLiquidity = parseFloat(args[i + 1]);
        break;
    }
  }
  return config;
}

async function fetchWithCache(url) {
  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  const res = await fetch(url, {
    headers: { Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  CACHE.set(url, { data, time: Date.now() });
  return data;
}

async function scanTrending(chain) {
  // Strategy: try token-boosts/top first, fall back to search endpoint
  const allPairs = [];

  // 1. Boosted tokens (paid promotion — high visibility)
  try {
    const data = await fetchWithCache(`${DEXSCREENER_BASE}/token-boosts/top/v1`);
    let tokens = Array.isArray(data) ? data : [];
    if (chain !== 'all') tokens = tokens.filter((t) => t.chainId === chain);
    const byChain = {};
    for (const t of tokens) {
      if (!byChain[t.chainId]) byChain[t.chainId] = [];
      if (byChain[t.chainId].length < 30) byChain[t.chainId].push(t.tokenAddress);
    }
    for (const [chainId, addresses] of Object.entries(byChain)) {
      const url = `${DEXSCREENER_BASE}/tokens/v1/${chainId}/${addresses.join(',')}`;
      try {
        const pairData = await fetchWithCache(url);
        const pairs = Array.isArray(pairData) ? pairData : (pairData.pairs ?? []);
        allPairs.push(...pairs);
      } catch {
        /* skip */
      }
    }
  } catch {
    /* boosts unavailable, continue to search fallback */
  }

  // 2. Search fallback — catches organic trending tokens not in boosts
  if (allPairs.length === 0 || chain !== 'all') {
    const q = chain === 'all' ? 'trending' : chain;
    try {
      const searchData = await fetchWithCache(`${DEXSCREENER_DEX}/search?q=${q}`);
      const searchPairs = searchData.pairs ?? [];
      // Deduplicate by pair address
      const seen = new Set(allPairs.map((p) => p.pairAddress));
      for (const p of searchPairs) {
        if (!seen.has(p.pairAddress)) allPairs.push(p);
      }
    } catch {
      /* search also failed */
    }
  }

  return { pairs: allPairs };
}

async function scanNewest(chain) {
  // Use token-profiles/latest for newest token listings
  const data = await fetchWithCache(`${DEXSCREENER_BASE}/token-profiles/latest/v1`);
  let tokens = Array.isArray(data) ? data : [];
  if (chain !== 'all') {
    tokens = tokens.filter((t) => t.chainId === chain);
  }
  // Batch lookup pair data
  const byChain = {};
  for (const t of tokens) {
    if (!byChain[t.chainId]) byChain[t.chainId] = [];
    if (byChain[t.chainId].length < 30) byChain[t.chainId].push(t.tokenAddress);
  }
  const allPairs = [];
  for (const [chainId, addresses] of Object.entries(byChain)) {
    const url = `${DEXSCREENER_BASE}/tokens/v1/${chainId}/${addresses.join(',')}`;
    try {
      const pairData = await fetchWithCache(url);
      const pairs = Array.isArray(pairData) ? pairData : (pairData.pairs ?? []);
      allPairs.push(...pairs);
    } catch {
      /* skip failed lookups */
    }
  }
  return { pairs: allPairs };
}

function getActiveNarratives() {
  const fallback = ['AI crypto', 'RWA token', 'DePIN', 'DeFi blue chip', 'L2 token', 'gaming crypto', 'SocialFi'];
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'narrative_momentum'").get();
    close();
    if (!row?.value) return fallback;
    const data = JSON.parse(row.value);
    // Use hot + warming narratives; build search queries from their keywords
    const active = [...(data.hottest ?? []), ...(data.warming ?? [])];
    if (active.length === 0) return fallback;
    const keywords = data.keywords ?? {};
    return active.map((name) => {
      const kw = keywords[name];
      return kw ? `${kw[0]} crypto` : `${name} crypto`;
    });
  } catch {
    return fallback;
  }
}

async function scanEstablished(chain) {
  // Search across active narratives for established tokens
  const narratives = getActiveNarratives();
  const allPairs = [];
  const seen = new Set();

  for (const query of narratives) {
    const q = chain === 'all' ? query : `${query} ${chain}`;
    try {
      const searchData = await fetchWithCache(`${DEXSCREENER_DEX}/search?q=${encodeURIComponent(q)}`);
      for (const p of searchData.pairs ?? []) {
        if (!seen.has(p.pairAddress)) {
          seen.add(p.pairAddress);
          allPairs.push(p);
        }
      }
    } catch {
      /* skip failed narrative searches */
    }
  }

  // Filter for established tokens: age > 7 days, volume > $50k
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const filtered = allPairs.filter((p) => {
    const createdAt = p.pairCreatedAt ?? 0;
    const volume = parseFloat(p.volume?.h24 ?? 0);
    return createdAt < sevenDaysAgo && volume >= 50_000;
  });

  return { pairs: filtered };
}

function formatToken(pair) {
  return {
    tokenAddress: pair.baseToken?.address ?? 'unknown',
    chain: pair.chainId ?? 'unknown',
    symbol: pair.baseToken?.symbol ?? 'unknown',
    name: pair.baseToken?.name ?? 'unknown',
    price: parseFloat(pair.priceUsd ?? 0),
    priceChange24h: parseFloat(pair.priceChange?.h24 ?? 0),
    volume24h: parseFloat(pair.volume?.h24 ?? 0),
    liquidity: parseFloat(pair.liquidity?.usd ?? 0),
    pairAddress: pair.pairAddress ?? 'unknown',
    dexId: pair.dexId ?? 'unknown',
    pairCreatedAt: pair.pairCreatedAt ? new Date(pair.pairCreatedAt).toISOString() : null,
    txns24h: {
      buys: pair.txns?.h24?.buys ?? 0,
      sells: pair.txns?.h24?.sells ?? 0,
    },
    url: pair.url ?? null,
  };
}

async function main() {
  const config = parseArgs();

  try {
    let data;
    if (config.sort === 'trending') {
      data = await scanTrending(config.chain);
    } else if (config.sort === 'established') {
      if (config.minLiquidity < 100_000) config.minLiquidity = 100_000;
      data = await scanEstablished(config.chain);
    } else {
      data = await scanNewest(config.chain);
    }

    let filteredPairs = (data.pairs ?? []).filter((p) => parseFloat(p.liquidity?.usd ?? 0) >= config.minLiquidity);

    // When scanning all chains, filter to only active chains
    if (config.chain === 'all') {
      filteredPairs = filteredPairs.filter((p) => isActive(p.chainId));
    }

    const pairs = filteredPairs.slice(0, config.limit).map(formatToken);

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          chain: config.chain,
          sort: config.sort,
          count: pairs.length,
          tokens: pairs,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
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
