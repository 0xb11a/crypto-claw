#!/usr/bin/env node
/**
 * market-overview.js — Get crypto market overview
 *
 * Usage:
 *   node scripts/market-overview.js
 */

import 'dotenv/config';

async function main() {
  try {
    // CoinGecko global data (free, no API key needed)
    const globalRes = await fetch('https://api.coingecko.com/api/v3/global');
    const globalData = await globalRes.json();

    // Fear & Greed Index
    const fgiRes = await fetch('https://api.alternative.me/fng/?limit=1');
    const fgiData = await fgiRes.json();

    const global = globalData.data;
    const fgi = fgiData.data?.[0];

    console.log(JSON.stringify({
      status: 'ok',
      market: {
        totalMarketCap: global.total_market_cap?.usd ?? 0,
        totalVolume24h: global.total_volume?.usd ?? 0,
        btcDominance: parseFloat((global.market_cap_percentage?.btc ?? 0).toFixed(2)),
        ethDominance: parseFloat((global.market_cap_percentage?.eth ?? 0).toFixed(2)),
        marketCapChange24h: parseFloat((global.market_cap_change_percentage_24h_usd ?? 0).toFixed(2)),
        activeCryptocurrencies: global.active_cryptocurrencies ?? 0,
      },
      fearGreed: {
        value: parseInt(fgi?.value ?? 50),
        classification: fgi?.value_classification ?? 'Neutral',
        timestamp: fgi?.timestamp ? new Date(parseInt(fgi.timestamp) * 1000).toISOString() : null,
      },
      topCoins: {
        btc: global.market_cap_percentage?.btc?.toFixed(2) + '% dominance',
        eth: global.market_cap_percentage?.eth?.toFixed(2) + '% dominance',
      },
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
