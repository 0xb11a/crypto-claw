#!/usr/bin/env node
/**
 * harvest.js — Shared wallet harvesting utilities
 *
 * Proposes wallets into tracked_wallets from API responses (Birdeye leaderboards,
 * token top traders, holder extraction). Used by score-wallet.js (per-call harvesting)
 * and score-wallets-bg.js (self-seeding harvest before scoring loop).
 *
 * Exports:
 *   harvestWallets(walletAddresses, chain, labelFn, source, excludeAddress)
 *   harvestBirdeyeLeaderboards()
 */

import { getDb } from './db.js';
import { getActiveChains, getChain } from './chains.js';
import { log } from './log.js';

// ============================================================
// Core harvest — propose wallets from API results
// ============================================================

export function harvestWallets(walletAddresses, chain, labelFn, source, excludeAddress) {
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
  } catch (err) {
    log('warn', 'harvest', `Wallet harvest failed for ${chain} (source=${source}): ${err.message}`);
    // Non-fatal — harvesting is best-effort
  }
  return harvested;
}

// ============================================================
// Birdeye leaderboard harvest — fetch top 100 gainers per chain
// ============================================================

const CHAIN_DELAY_MS = 3000; // 3s between chains (Birdeye free tier: 1 rps global)
const MAX_RETRIES = 2;
const RETRY_BASE_MS = 5000; // 5s, 10s exponential backoff

async function fetchWithRetry(url, headers, label) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, { headers });

    if (res.ok) return res;

    if (res.status === 429 && attempt < MAX_RETRIES) {
      const delay = RETRY_BASE_MS * Math.pow(2, attempt);
      log('warn', 'harvest', `${label}: HTTP 429, retry in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      console.error(`[harvest] ${label}: HTTP 429, retry in ${delay / 1000}s (attempt ${attempt + 1}/${MAX_RETRIES})`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    // Log response body for non-OK responses to aid debugging
    if (!res.ok) {
      try {
        const body = await res.text();
        log('warn', 'harvest', `${label}: HTTP ${res.status} — ${body.slice(0, 200)}`);
        console.error(`[harvest] ${label}: HTTP ${res.status} — ${body.slice(0, 200)}`);
      } catch {
        /* ignore body read errors */
      }
    }

    return res; // non-429 error or exhausted retries
  }
}

export async function harvestBirdeyeLeaderboards() {
  const apiKey = process.env.BIRDEYE_API_KEY;
  if (!apiKey) return { totalHarvested: 0, chains: {} };

  const activeChains = getActiveChains()
    .map((name) => {
      try {
        return { name, birdeye: getChain(name).birdeye };
      } catch (err) {
        log('warn', 'harvest', `Chain ${name} has no Birdeye config, skipping: ${err.message}`);
        return null;
      }
    })
    .filter((c) => c && c.birdeye);

  let totalHarvested = 0;
  const chains = {};

  for (let i = 0; i < activeChains.length; i++) {
    const { name, birdeye } = activeChains[i];
    try {
      const url = `https://public-api.birdeye.so/trader/gainers-losers?type=today&sort_by=PnL&sort_type=desc&limit=10`;
      const headers = { 'X-API-KEY': apiKey, 'x-chain': birdeye };
      const res = await fetchWithRetry(url, headers, `Birdeye ${name}`);

      if (!res.ok) {
        chains[name] = 0;
        continue;
      }

      const data = await res.json();
      if (!data.success || !data.data?.items) {
        log('warn', 'harvest', `Birdeye ${name}: no items in leaderboard response`);
        console.error(`[harvest] Birdeye ${name}: no items in response`);
        chains[name] = 0;
        continue;
      }

      const allAddresses = data.data.items.map((t) => t.address).filter(Boolean);
      const rankByAddress = new Map(data.data.items.map((t, idx) => [t.address?.toLowerCase(), idx + 1]));

      const count = harvestWallets(
        allAddresses,
        name,
        (addr) => `birdeye_leaderboard_top${rankByAddress.get(addr.toLowerCase()) ?? 0}`,
        'leaderboard',
        null,
      );

      chains[name] = count;
      totalHarvested += count;
    } catch (err) {
      log('warn', 'harvest', `Birdeye leaderboard harvest failed for ${name}: ${err.message}`);
      console.error(`[harvest] Birdeye ${name} failed: ${err.message}`);
      chains[name] = 0;
    }

    // Rate limit between chains (skip after last)
    if (i < activeChains.length - 1) {
      await new Promise((r) => setTimeout(r, CHAIN_DELAY_MS));
    }
  }

  return { totalHarvested, chains };
}
