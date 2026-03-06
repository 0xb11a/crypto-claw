#!/usr/bin/env node
/**
 * token-metrics.js — Get detailed metrics for a specific token
 *
 * Usage:
 *   node scripts/token-metrics.js --address 0x1234... --chain ethereum
 */

import 'dotenv/config';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '' };
  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--address': config.address = args[i + 1]; break;
      case '--chain': config.chain = args[i + 1]; break;
    }
  }
  if (!config.address) {
    console.error('Error: --address is required');
    process.exit(1);
  }
  return config;
}

async function getTokenMetrics(address, chain) {
  // Get pair data from DEXScreener
  const url = `${DEXSCREENER_BASE}/tokens/${address}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`DEXScreener API error: ${res.status}`);
  const data = await res.json();

  const pairs = data.pairs ?? [];
  if (pairs.length === 0) {
    return { status: 'not_found', address, message: 'No trading pairs found' };
  }

  // Use the highest-liquidity pair
  const mainPair = pairs.sort((a, b) =>
    parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0)
  )[0];

  return {
    status: 'ok',
    token: {
      address: mainPair.baseToken?.address,
      symbol: mainPair.baseToken?.symbol,
      name: mainPair.baseToken?.name,
      chain: mainPair.chainId,
    },
    metrics: {
      price: parseFloat(mainPair.priceUsd ?? 0),
      priceChange: {
        m5: parseFloat(mainPair.priceChange?.m5 ?? 0),
        h1: parseFloat(mainPair.priceChange?.h1 ?? 0),
        h6: parseFloat(mainPair.priceChange?.h6 ?? 0),
        h24: parseFloat(mainPair.priceChange?.h24 ?? 0),
      },
      volume: {
        h1: parseFloat(mainPair.volume?.h1 ?? 0),
        h6: parseFloat(mainPair.volume?.h6 ?? 0),
        h24: parseFloat(mainPair.volume?.h24 ?? 0),
      },
      liquidity: parseFloat(mainPair.liquidity?.usd ?? 0),
      fdv: parseFloat(mainPair.fdv ?? 0),
      marketCap: parseFloat(mainPair.marketCap ?? 0),
      txns: {
        h1: mainPair.txns?.h1 ?? { buys: 0, sells: 0 },
        h6: mainPair.txns?.h6 ?? { buys: 0, sells: 0 },
        h24: mainPair.txns?.h24 ?? { buys: 0, sells: 0 },
      },
      pairCreatedAt: mainPair.pairCreatedAt
        ? new Date(mainPair.pairCreatedAt).toISOString()
        : null,
      ageHours: mainPair.pairCreatedAt
        ? ((Date.now() - mainPair.pairCreatedAt) / 3_600_000).toFixed(1)
        : null,
    },
    dex: mainPair.dexId,
    pairAddress: mainPair.pairAddress,
    url: mainPair.url,
    totalPairs: pairs.length,
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const config = parseArgs();
  try {
    const result = await getTokenMetrics(config.address, config.chain);
    console.log(JSON.stringify(result, null, 2));
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
