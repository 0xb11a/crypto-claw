#!/usr/bin/env node
/**
 * score-wallet.js — Score a wallet's trading profitability (smart money detection)
 *
 * Uses Birdeye trader endpoints (Solana + EVM) and Zerion PnL (EVM fallback)
 * to evaluate wallet profitability and compute a smart money score (0-100).
 *
 * Usage:
 *   node scripts/score-wallet.js --address 0x1234... --chain ethereum
 *   node scripts/score-wallet.js --address ABC123... --chain solana
 *   node scripts/score-wallet.js --address 0x1234... --chain base --add   # score + auto-add if qualifies
 *
 * Output: JSON with score, PnL breakdown, and classification.
 *
 * API priority:
 *   Birdeye trader/gainers-losers  — checks if wallet is a top PnL trader (Solana + EVM)
 *   Birdeye defi/txs/token         — fetches recent trades for the wallet (via token)
 *   Zerion /wallets/{addr}/pnl     — cross-chain PnL with realized/unrealized breakdown (EVM)
 */

import 'dotenv/config';
import { getDb, close } from './db.js';

// ============================================================
// Wallet harvesting helper — propose wallets from API results
// ============================================================

function harvestWallets(walletAddresses, chain, labelFn, source, excludeAddress) {
  let harvested = 0;
  try {
    const db = getDb();
    const stmt = db.prepare(`
      INSERT OR IGNORE INTO tracked_wallets (address, chain, label, source, status)
      VALUES (?, ?, ?, ?, 'proposed')
    `);
    const excludeLower = excludeAddress?.toLowerCase();
    const insertMany = db.transaction((addrs) => {
      for (const addr of addrs) {
        if (!addr || addr.toLowerCase() === excludeLower) continue;
        const result = stmt.run(addr, chain, labelFn(addr), source);
        harvested += result.changes; // 1 if inserted, 0 if duplicate ignored
      }
    });
    insertMany(walletAddresses);
  } catch {
    // Non-fatal — harvesting is best-effort
  }
  return harvested;
}

import { getChain } from './chains.js';

// ============================================================
// CLI args
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '', add: false, label: '', token: '' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--address':
        config.address = args[++i];
        break;
      case '--chain':
        config.chain = args[++i];
        break;
      case '--add':
        config.add = true;
        break;
      case '--label':
        config.label = args[++i];
        break;
      case '--token':
        config.token = args[++i];
        break;
    }
  }
  if (!config.address || !config.chain) {
    console.error('Error: --address and --chain are required');
    process.exit(1);
  }
  return config;
}

// ============================================================
// Birdeye: Check if wallet is in top gainers list
// ============================================================

async function fetchBirdeyeTraderRank(address, chain) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return null;

  let birdeyeChain;
  try {
    birdeyeChain = getChain(chain).birdeye;
  } catch {
    return null;
  }
  if (!birdeyeChain) return null;

  try {
    // Fetch top 100 gainers today — check if our wallet is among them
    const url = `https://public-api.birdeye.so/trader/gainers-losers?type=today&sort_by=PnL&sort_type=desc&limit=100`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': birdeyeChain },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success || !data.data?.items) return null;

    // Harvest all wallets from the leaderboard response
    const allAddresses = data.data.items.map((t) => t.address).filter(Boolean);
    const rankByAddress = new Map(data.data.items.map((t, i) => [t.address?.toLowerCase(), i + 1]));
    const walletsHarvested = harvestWallets(
      allAddresses,
      chain,
      (addr) => `birdeye_leaderboard_top${rankByAddress.get(addr.toLowerCase()) ?? 0}`,
      'leaderboard',
      address,
    );

    // Find our wallet in the list
    const match = data.data.items.find((t) => t.address?.toLowerCase() === address.toLowerCase());

    if (match) {
      const rank = data.data.items.indexOf(match) + 1;
      return {
        source: 'birdeye_trader',
        inTopGainers: true,
        rank,
        pnl: match.pnl ?? 0,
        volume: match.volume ?? 0,
        tradeCount: match.trade_count ?? 0,
        totalTraders: data.data.items.length,
        walletsHarvested,
      };
    }

    return {
      source: 'birdeye_trader',
      inTopGainers: false,
      rank: null,
      // Return the median PnL as context
      medianPnl: data.data.items[Math.floor(data.data.items.length / 2)]?.pnl ?? 0,
      topPnl: data.data.items[0]?.pnl ?? 0,
      walletsHarvested,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Birdeye: Get wallet's token trading stats (via token top traders)
// ============================================================

async function fetchBirdeyeTokenTraderStats(address, chain, tokenAddress) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey || !tokenAddress) return null;

  let birdeyeChain;
  try {
    birdeyeChain = getChain(chain).birdeye;
  } catch {
    return null;
  }
  if (!birdeyeChain) return null;

  try {
    const url = `https://public-api.birdeye.so/defi/v2/tokens/top_traders?address=${tokenAddress}&sort_by=volume&sort_type=desc&limit=50`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': birdeyeChain },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.success || !data.data?.items) return null;

    // Harvest all top traders from the response
    const tokenSymbol = tokenAddress.slice(0, 8);
    const allAddresses = data.data.items.map((t) => t.owner).filter(Boolean);
    const walletsHarvested = harvestWallets(
      allAddresses,
      chain,
      () => `top_trader_of_${tokenSymbol}`,
      'token_traders',
      address,
    );

    const match = data.data.items.find((t) => t.owner?.toLowerCase() === address.toLowerCase());

    if (match) {
      return {
        isTopTrader: true,
        rank: data.data.items.indexOf(match) + 1,
        volume: match.volume ?? 0,
        trades: match.trade ?? 0,
        buys: match.tradeBuy ?? 0,
        sells: match.tradeSell ?? 0,
        volumeBuy: match.volumeBuy ?? 0,
        volumeSell: match.volumeSell ?? 0,
        walletsHarvested,
      };
    }

    return { isTopTrader: false, walletsHarvested };
  } catch {
    return null;
  }
}

// ============================================================
// Birdeye: Fetch wallet's recent swaps for a token
// ============================================================

async function _fetchBirdeyeWalletSwaps(address, chain, tokenAddress) {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey || !tokenAddress) return null;

  let birdeyeChain;
  try {
    birdeyeChain = getChain(chain).birdeye;
  } catch {
    return null;
  }
  if (!birdeyeChain) return null;

  try {
    const url = `https://public-api.birdeye.so/defi/txs/token?address=${tokenAddress}&tx_type=swap&sort_type=desc&limit=50`;
    const res = await fetch(url, {
      headers: { 'X-API-KEY': apiKey, 'x-chain': birdeyeChain },
    });

    if (!res.ok) return null;
    const data = await res.json();
    if (!data.data?.items) return null;

    // Filter to only this wallet's swaps
    const walletSwaps = data.data.items.filter(
      (tx) => tx.owner?.toLowerCase() === address.toLowerCase() || tx.source?.toLowerCase() === address.toLowerCase(),
    );

    if (walletSwaps.length === 0) return null;

    let totalBuyVol = 0;
    let totalSellVol = 0;
    let buyCount = 0;
    let sellCount = 0;

    for (const tx of walletSwaps) {
      const baseChange = tx.base?.changeAmount ?? 0;
      const vol = Math.abs(tx.quote?.uiAmount ?? 0);
      if (baseChange > 0) {
        totalBuyVol += vol;
        buyCount++;
      } else {
        totalSellVol += vol;
        sellCount++;
      }
    }

    return {
      source: 'birdeye_swaps',
      swapCount: walletSwaps.length,
      buyCount,
      sellCount,
      totalBuyVol,
      totalSellVol,
      netFlow: totalBuyVol - totalSellVol,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Zerion Wallet PnL (EVM)
// ============================================================

async function fetchZerionPnl(address, chain) {
  const apiKey = process.env.ZERION_API_KEY;
  if (!apiKey) return null;

  if (chain === 'solana') return null;

  try {
    const url = `https://api.zerion.io/v1/wallets/${address}/pnl/?currency=usd`;
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        authorization: `Basic ${Buffer.from(apiKey + ':').toString('base64')}`,
      },
    });

    if (!res.ok) return null;
    const data = await res.json();

    const pnl = data.data?.attributes;
    if (!pnl) return null;

    const realizedPnl = pnl.realized_gain ?? 0;
    const unrealizedPnl = pnl.unrealized_gain ?? 0;
    const costBasis = pnl.realized_cost_basis ?? pnl.total_invested ?? 0;

    return {
      source: 'zerion',
      realizedPnl,
      unrealizedPnl,
      totalPnl: pnl.total_gain ?? realizedPnl + unrealizedPnl,
      totalInvested: costBasis > 0 ? costBasis : (pnl.total_invested ?? 0),
      relativeRealizedGain: pnl.relative_realized_gain_percentage ?? null,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Scoring engine
// ============================================================

function computeScore(traderRank, zerionPnl, tokenStats) {
  const scores = {
    profitability: 0, // 0-100: PnL performance
    consistency: 0, // 0-100: trade pattern quality
    volume: 0, // 0-100: meaningful trading volume
    activity: 0, // 0-100: active trader
    reputation: 0, // 0-100: appears in leaderboards
  };

  let dataPoints = 0;

  // --- Birdeye trader rank data ---
  if (traderRank) {
    dataPoints++;

    if (traderRank.inTopGainers) {
      // In top 100 gainers = strong signal
      scores.reputation = traderRank.rank <= 10 ? 100 : traderRank.rank <= 25 ? 85 : traderRank.rank <= 50 ? 70 : 55;

      scores.profitability =
        traderRank.pnl > 100_000 ? 100 : traderRank.pnl > 10_000 ? 85 : traderRank.pnl > 1_000 ? 70 : 55;

      scores.volume =
        traderRank.volume > 1_000_000 ? 100 : traderRank.volume > 100_000 ? 80 : traderRank.volume > 10_000 ? 60 : 40;

      scores.activity =
        traderRank.tradeCount > 100 ? 100 : traderRank.tradeCount > 50 ? 80 : traderRank.tradeCount > 10 ? 60 : 40;
    } else {
      // Not in top 100, use whatever context we have
      scores.reputation = 15;
    }
  }

  // --- Zerion PnL data (EVM only) ---
  if (zerionPnl) {
    dataPoints++;

    const roi =
      zerionPnl.relativeRealizedGain != null
        ? zerionPnl.relativeRealizedGain / 100
        : zerionPnl.totalInvested > 0
          ? zerionPnl.totalPnl / zerionPnl.totalInvested
          : 0;

    const profitScore =
      roi > 5 ? 100 : roi > 2 ? 85 : roi > 1 ? 70 : roi > 0.5 ? 55 : roi > 0.1 ? 40 : roi > 0 ? 25 : 10;

    // Average with Birdeye if both exist
    scores.profitability =
      scores.profitability > 0 ? Math.round((scores.profitability + profitScore) / 2) : profitScore;

    // Cost basis indicates portfolio size
    const invested = zerionPnl.totalInvested;
    const sizeScore =
      invested > 1_000_000 ? 100 : invested > 100_000 ? 80 : invested > 10_000 ? 60 : invested > 1_000 ? 40 : 15;
    scores.volume = scores.volume > 0 ? Math.round((scores.volume + sizeScore) / 2) : sizeScore;
  }

  // --- Token-specific trader data (bonus) ---
  if (tokenStats?.isTopTrader) {
    dataPoints++;
    // Being a top trader for a specific token is a strong signal
    const bonus = tokenStats.rank <= 5 ? 20 : tokenStats.rank <= 20 ? 10 : 5;
    scores.reputation = Math.min(100, scores.reputation + bonus);

    if (scores.activity === 0) {
      scores.activity = tokenStats.trades > 50 ? 80 : tokenStats.trades > 10 ? 60 : 40;
    }

    // Buy/sell ratio can indicate conviction
    if (tokenStats.buys > 0 && tokenStats.sells > 0) {
      const ratio = tokenStats.volumeBuy / (tokenStats.volumeSell || 1);
      scores.consistency =
        ratio > 2
          ? 70 // heavy accumulator
          : ratio > 1
            ? 60 // net buyer
            : ratio > 0.5
              ? 40 // balanced
              : 30; // net seller
    }
  }

  if (dataPoints === 0) {
    return { overall: 0, scores, classification: 'unknown', reason: 'No data available from any API' };
  }

  // Weighted overall
  const overall = Math.round(
    scores.profitability * 0.3 +
      scores.reputation * 0.25 +
      scores.volume * 0.2 +
      scores.activity * 0.15 +
      scores.consistency * 0.1,
  );

  // Classification
  let classification;
  let reason;
  if (overall >= 75) {
    classification = 'smart_money';
    reason = 'Top-ranked trader with high PnL and consistent volume';
  } else if (overall >= 55) {
    classification = 'whale';
    reason = 'Significant trading activity with above-average returns';
  } else if (overall >= 35) {
    classification = 'trader';
    reason = 'Active trader with moderate results';
  } else {
    classification = 'retail';
    reason = 'Not in top trader rankings or low trading performance';
  }

  return { overall, scores, classification, reason };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();
  const { address, chain } = config;

  try {
    // Fetch data from all available sources in parallel
    const [traderRank, zerionPnl, tokenStats] = await Promise.all([
      fetchBirdeyeTraderRank(address, chain),
      chain !== 'solana' ? fetchZerionPnl(address, chain) : null,
      config.token ? fetchBirdeyeTokenTraderStats(address, chain, config.token) : null,
    ]);

    // Check if we have any data at all
    if (!traderRank && !zerionPnl && !tokenStats) {
      const missing = [];
      if (!process.env.BIRDEYE_API_KEY) missing.push('BIRDEYE_API_KEY');
      if (!process.env.ZERION_API_KEY && chain !== 'solana') missing.push('ZERION_API_KEY');

      console.log(
        JSON.stringify(
          {
            status: 'no_data',
            address,
            chain,
            message:
              missing.length > 0
                ? `Set ${missing.join(' or ')} to enable wallet scoring`
                : 'APIs returned no data for this wallet',
            score: null,
            timestamp: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      return;
    }

    // Score the wallet
    const score = computeScore(traderRank, zerionPnl, tokenStats);

    // Build PnL summary from available data
    const pnlSummary = {};
    if (traderRank?.inTopGainers) {
      pnlSummary.todayPnl = traderRank.pnl;
      pnlSummary.todayVolume = traderRank.volume;
      pnlSummary.todayTrades = traderRank.tradeCount;
      pnlSummary.leaderboardRank = traderRank.rank;
    }
    if (zerionPnl) {
      pnlSummary.realizedPnl = Math.round(zerionPnl.realizedPnl * 100) / 100;
      pnlSummary.unrealizedPnl = Math.round(zerionPnl.unrealizedPnl * 100) / 100;
      pnlSummary.totalInvested = Math.round(zerionPnl.totalInvested * 100) / 100;
      if (zerionPnl.relativeRealizedGain != null) {
        pnlSummary.realizedRoi = Math.round(zerionPnl.relativeRealizedGain * 100) / 100;
      }
    }

    // Auto-add to tracked_wallets if --add and qualifies
    let added = false;
    if (config.add && score.classification !== 'retail' && score.classification !== 'unknown') {
      try {
        const db = getDb();
        const label = config.label || `${score.classification} (score: ${score.overall})`;
        db.prepare(
          `
          INSERT OR REPLACE INTO tracked_wallets (address, chain, label, type, notes)
          VALUES (?, ?, ?, ?, ?)
        `,
        ).run(
          address,
          chain,
          label,
          score.classification === 'smart_money' ? 'smart_money' : 'whale',
          `Auto-scored: ${score.overall}/100. ${score.reason}`,
        );
        added = true;
        close();
      } catch (err) {
        console.error(`[score-wallet] DB error: ${err.message}`);
      }
    }

    const sources = [
      traderRank ? 'birdeye_trader' : null,
      zerionPnl ? 'zerion' : null,
      tokenStats ? 'birdeye_token' : null,
    ].filter(Boolean);

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          address,
          chain,
          sources,
          score: {
            overall: score.overall,
            classification: score.classification,
            reason: score.reason,
            breakdown: score.scores,
          },
          pnl: pnlSummary,
          ...(tokenStats?.isTopTrader
            ? {
                tokenTrader: {
                  rank: tokenStats.rank,
                  volume: tokenStats.volume,
                  trades: tokenStats.trades,
                  buys: tokenStats.buys,
                  sells: tokenStats.sells,
                },
              }
            : {}),
          walletsHarvested: (traderRank?.walletsHarvested ?? 0) + (tokenStats?.walletsHarvested ?? 0),
          ...(config.add ? { addedToTracked: added } : {}),
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
        address,
        chain,
        error: err.message,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }
}

main();
