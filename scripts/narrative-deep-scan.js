#!/usr/bin/env node
/**
 * narrative-deep-scan.js — Deep narrative analysis with ranked token results
 *
 * Two modes:
 *   Manual (default): all keywords, top 30 candidates, returns top 10
 *   Agent (--quick):  top 1 keyword, top 15 candidates, returns top 3
 *
 * Usage:
 *   node scripts/narrative-deep-scan.js --narrative ai_infra                     # Manual, single
 *   node scripts/narrative-deep-scan.js --narrative all                          # Manual, all
 *   node scripts/narrative-deep-scan.js --narrative all --hot-only               # Manual, hot/warming only
 *   node scripts/narrative-deep-scan.js --narrative ai_infra --quick             # Agent mode
 *   node scripts/narrative-deep-scan.js --narrative all --hot-only --quick       # Agent heartbeat
 *   node scripts/narrative-deep-scan.js --narrative ai_infra --chain base --limit 5
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { NARRATIVES, getAllIds } from './narrative-config.js';
import { getActiveChains, getStablecoins } from './chains.js';

const DEXSCREENER_SEARCH = 'https://api.dexscreener.com/latest/dex/search';
const DEXSCREENER_TOKENS = 'https://api.dexscreener.com/tokens/v1';
const API_DELAY = 300; // ms between API calls

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { narrative: null, chain: 'all', limit: null, quick: false, hotOnly: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--narrative':
        config.narrative = args[++i];
        break;
      case '--chain':
        config.chain = args[++i];
        break;
      case '--limit':
        config.limit = parseInt(args[++i]);
        break;
      case '--quick':
        config.quick = true;
        break;
      case '--hot-only':
        config.hotOnly = true;
        break;
    }
  }
  if (!config.narrative) {
    console.error('Error: --narrative is required (use a narrative ID or "all")');
    process.exit(1);
  }
  // Set defaults based on mode
  if (config.limit === null) {
    config.limit = config.quick ? 3 : 10;
  }
  return config;
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchSearch(keyword) {
  const url = `${DEXSCREENER_SEARCH}?q=${encodeURIComponent(keyword)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Search API error: ${res.status}`);
  return res.json();
}

async function fetchTokenPairs(chain, addresses) {
  // eslint-disable-line no-unused-vars
  // DEXScreener tokens endpoint: up to 30 addresses per call
  const url = `${DEXSCREENER_TOKENS}/${chain}/${addresses.join(',')}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Tokens API error: ${res.status}`);
  return res.json();
}

/**
 * Check if address is a stablecoin on any active chain.
 */
function isStablecoin(address, chain) {
  try {
    const stables = getStablecoins(chain);
    const normalized = chain === 'solana' ? address : address.toLowerCase();
    return stables.has(normalized);
  } catch {
    return false;
  }
}

/**
 * Get hot/warming narratives from DB (for --hot-only flag).
 */
function getHotNarratives() {
  try {
    const db = getDb();
    const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'narrative_momentum'").get();
    close();
    if (!row?.value) return [];
    const data = JSON.parse(row.value);
    return [...(data.hottest ?? []), ...(data.warming ?? [])];
  } catch {
    return [];
  }
}

/**
 * Score a token candidate for ranking within a narrative.
 *
 * Scoring weights:
 *   volume24h:     25%  — trading activity
 *   liquidity:     20%  — depth
 *   priceChange:   20%  — momentum
 *   buyRatio:      15%  — demand pressure
 *   ageFreshness:  10%  — newer = more opportunity
 *   pairCount:     10%  — market presence
 */
function scoreCandidate(candidate) {
  const { volume24h, liquidity, priceChange24h, buyRatio, ageHours, pairCount } = candidate;

  // Volume score: log scale, 0-100
  const volumeScore = Math.min(100, Math.max(0, (Math.log10(Math.max(volume24h, 1)) / 7) * 100));

  // Liquidity score: log scale, 0-100
  const liquidityScore = Math.min(100, Math.max(0, (Math.log10(Math.max(liquidity, 1)) / 7) * 100));

  // Price change score: -50% to +100% mapped to 0-100
  const changeScore = Math.min(100, Math.max(0, (priceChange24h + 50) * (100 / 150)));

  // Buy ratio score: 0.5-3.0 mapped to 0-100
  const ratioScore = Math.min(100, Math.max(0, ((buyRatio - 0.5) / 2.5) * 100));

  // Age freshness: newer is better for discovery (< 72h ideal)
  const ageScore = ageHours <= 0 ? 50 : ageHours < 24 ? 100 : ageHours < 72 ? 80 : ageHours < 168 ? 60 : 40;

  // Pair count: more pairs = more established
  const pairScore = Math.min(100, pairCount * 15);

  return Math.round(
    volumeScore * 0.25 +
      liquidityScore * 0.2 +
      changeScore * 0.2 +
      ratioScore * 0.15 +
      ageScore * 0.1 +
      pairScore * 0.1,
  );
}

/**
 * Determine suggested tier based on narrative affinity + token metrics.
 */
function suggestTier(narrativeConfig, candidate) {
  const { tierAffinity } = narrativeConfig;
  const { ageHours, liquidity, marketCap, verified } = candidate;

  // strong_moonshot: always moonshot
  if (tierAffinity === 'strong_moonshot') return 'moonshot';

  const meetsConviction = ageHours > 168 && liquidity > 100_000 && marketCap > 1_000_000 && verified;

  if (tierAffinity === 'strong_conviction' || tierAffinity === 'lean_conviction') {
    return meetsConviction ? 'conviction' : 'moonshot';
  }

  // lean_moonshot: only conviction if exceptional
  if (tierAffinity === 'lean_moonshot') {
    const exceptional = ageHours > 720 && liquidity > 500_000;
    return exceptional ? 'conviction' : 'moonshot';
  }

  return 'moonshot';
}

/**
 * Deep scan a single narrative.
 */
async function deepScanNarrative(id, config, options) {
  const narrativeConfig = config;
  const { quick, chain, limit } = options;
  const activeChains = chain === 'all' ? getActiveChains() : [chain];

  // Determine keywords to search
  const keywords = quick ? config.keywords.slice(0, 1) : config.keywords;
  const maxCandidates = quick ? 15 : 30;

  // Step 1: Search DEXScreener for all keywords
  const allPairs = [];
  const seenAddresses = new Set();

  for (const keyword of keywords) {
    try {
      const data = await fetchSearch(keyword);
      for (const p of data.pairs ?? []) {
        const addr = p.baseToken?.address;
        if (!addr || seenAddresses.has(addr)) continue;
        if (!activeChains.includes(p.chainId)) continue;

        const liq = parseFloat(p.liquidity?.usd ?? 0);
        if (liq < 5000) continue;
        if (isStablecoin(addr, p.chainId)) continue;

        seenAddresses.add(addr);
        allPairs.push(p);
      }
    } catch {
      /* skip failed keyword search */
    }
    await delay(API_DELAY);
  }

  // Step 2: Sort by volume and take top candidates
  const candidates = allPairs
    .sort((a, b) => parseFloat(b.volume?.h24 ?? 0) - parseFloat(a.volume?.h24 ?? 0))
    .slice(0, maxCandidates);

  // Step 3: Build scored candidate list
  const scored = candidates.map((p) => {
    const buys = p.txns?.h24?.buys ?? 0;
    const sells = p.txns?.h24?.sells ?? 0;
    const ageMs = p.pairCreatedAt ? Date.now() - p.pairCreatedAt : 0;

    const candidate = {
      address: p.baseToken?.address ?? 'unknown',
      chain: p.chainId ?? 'unknown',
      symbol: p.baseToken?.symbol ?? 'unknown',
      name: p.baseToken?.name ?? 'unknown',
      price: parseFloat(p.priceUsd ?? 0),
      volume24h: parseFloat(p.volume?.h24 ?? 0),
      liquidity: parseFloat(p.liquidity?.usd ?? 0),
      marketCap: parseFloat(p.marketCap ?? p.fdv ?? 0),
      priceChange24h: parseFloat(p.priceChange?.h24 ?? 0),
      ageHours: ageMs > 0 ? parseFloat((ageMs / 3_600_000).toFixed(1)) : 0,
      buyRatio: sells > 0 ? parseFloat((buys / sells).toFixed(2)) : buys > 0 ? 5.0 : 1.0,
      pairCount: 1,
      verified: true, // Assume verified if on DEXScreener; check-contract.js validates later
      url: p.url ?? `https://dexscreener.com/${p.chainId}/${p.pairAddress}`,
    };

    candidate.score = scoreCandidate(candidate);
    candidate.suggestedTier = suggestTier(narrativeConfig, candidate);
    return candidate;
  });

  // Step 4: Rank by score, take top N
  const ranked = scored.sort((a, b) => b.score - a.score).slice(0, limit);

  // Calculate narrative-level momentum
  const avgChange = scored.length > 0 ? scored.reduce((sum, c) => sum + c.priceChange24h, 0) / scored.length : 0;
  const momentum = avgChange > 10 ? 'hot' : avgChange > 0 ? 'warming' : avgChange > -10 ? 'cooling' : 'cold';

  return {
    status: 'ok',
    narrative: id,
    narrativeName: config.name,
    category: config.category,
    momentum,
    tierAffinity: config.tierAffinity,
    candidatesFound: allPairs.length,
    mode: quick ? 'quick' : 'manual',
    tokens: ranked.map((c, i) => ({
      rank: i + 1,
      address: c.address,
      chain: c.chain,
      symbol: c.symbol,
      name: c.name,
      price: c.price,
      volume24h: c.volume24h,
      liquidity: c.liquidity,
      marketCap: c.marketCap,
      priceChange24h: c.priceChange24h,
      ageHours: c.ageHours,
      buyRatio: c.buyRatio,
      suggestedTier: c.suggestedTier,
      score: c.score,
      url: c.url,
    })),
  };
}

async function main() {
  const args = parseArgs();

  try {
    let narrativeIds;

    if (args.narrative === 'all') {
      narrativeIds = getAllIds();
      if (args.hotOnly) {
        const hot = getHotNarratives();
        if (hot.length === 0) {
          console.log(
            JSON.stringify(
              {
                status: 'ok',
                message: 'No hot/warming narratives found. Run narrative-check.js first.',
                narratives: [],
                timestamp: new Date().toISOString(),
              },
              null,
              2,
            ),
          );
          return;
        }
        narrativeIds = narrativeIds.filter((id) => hot.includes(id));
      }
    } else {
      if (!NARRATIVES[args.narrative]) {
        console.error(`Unknown narrative: ${args.narrative}. Known: ${getAllIds().join(', ')}`);
        process.exit(1);
      }
      narrativeIds = [args.narrative];
    }

    const results = [];
    for (const id of narrativeIds) {
      const result = await deepScanNarrative(id, NARRATIVES[id], {
        quick: args.quick,
        chain: args.chain,
        limit: args.limit,
      });
      results.push(result);
      // Delay between narratives to avoid rate limiting
      if (narrativeIds.length > 1) await delay(API_DELAY);
    }

    // Single narrative: output directly
    if (results.length === 1) {
      console.log(JSON.stringify(results[0], null, 2));
      return;
    }

    // Multiple narratives: wrap in summary
    const output = {
      status: 'ok',
      mode: args.quick ? 'quick' : 'manual',
      narrativeCount: results.length,
      narratives: results,
      summary: {
        hottest: results.filter((r) => r.momentum === 'hot').map((r) => r.narrative),
        warming: results.filter((r) => r.momentum === 'warming').map((r) => r.narrative),
        totalTokensFound: results.reduce((sum, r) => sum + r.tokens.length, 0),
      },
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
