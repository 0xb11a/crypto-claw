#!/usr/bin/env node
/**
 * scan-tokens.js — Scan DEXScreener for trending/new tokens
 *
 * Usage:
 *   node scripts/scan-tokens.js --chain solana --sort trending --limit 20
 *   node scripts/scan-tokens.js --chain base --sort newest --min-liquidity 10000
 */

import 'dotenv/config';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const CACHE = new Map();
const CACHE_TTL = 60_000; // 60 seconds

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: 'all', sort: 'trending', limit: 20, minLiquidity: 5000 };
  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--chain': config.chain = args[i + 1]; break;
      case '--sort': config.sort = args[i + 1]; break;
      case '--limit': config.limit = parseInt(args[i + 1]); break;
      case '--min-liquidity': config.minLiquidity = parseFloat(args[i + 1]); break;
    }
  }
  return config;
}

async function fetchWithCache(url) {
  const cached = CACHE.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL) return cached.data;

  const res = await fetch(url, {
    headers: { 'Accept': 'application/json' }
  });
  if (!res.ok) throw new Error(`API error: ${res.status} ${res.statusText}`);
  const data = await res.json();
  CACHE.set(url, { data, time: Date.now() });
  return data;
}

async function scanTrending(chain) {
  // DEXScreener trending endpoint
  const url = chain === 'all'
    ? `${DEXSCREENER_BASE}/search?q=trending`
    : `${DEXSCREENER_BASE}/search?q=trending+${chain}`;
  return fetchWithCache(url);
}

async function scanNewest(chain) {
  const url = `${DEXSCREENER_BASE}/pairs/${chain}`;
  return fetchWithCache(url);
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
    } else {
      data = await scanNewest(config.chain);
    }

    const pairs = (data.pairs ?? [])
      .filter(p => parseFloat(p.liquidity?.usd ?? 0) >= config.minLiquidity)
      .slice(0, config.limit)
      .map(formatToken);

    console.log(JSON.stringify({
      status: 'ok',
      chain: config.chain,
      sort: config.sort,
      count: pairs.length,
      tokens: pairs,
      timestamp: new Date().toISOString(),
    }, null, 2));
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
