#!/usr/bin/env node
/**
 * holder-distribution.js — Check token holder distribution
 *
 * Usage:
 *   node scripts/holder-distribution.js --address 0x1234... --chain ethereum
 */

import 'dotenv/config';
import { getChain, isSolana } from './chains.js';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '', propose: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--address') {
      config.address = args[++i];
      continue;
    }
    if (args[i] === '--chain') {
      config.chain = args[++i];
      continue;
    }
    if (args[i] === '--propose') {
      config.propose = true;
      continue;
    }
  }
  if (!config.address || !config.chain) {
    console.error('Error: --address and --chain are required');
    process.exit(1);
  }
  return config;
}

/**
 * Fetch holder data from GoPlus Labs.
 * Returns { holderCount, holders[] } or null if data is unavailable.
 */
async function fetchHoldersFromGoPlus(address, chain, chainCfg) {
  const url = isSolana(chain)
    ? `${GOPLUS_BASE}/${chainCfg.goplus.endpoint}/token_security?contract_addresses=${address}`
    : `${GOPLUS_BASE}/token_security/${chainCfg.goplus.chainId}?contract_addresses=${address}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GoPlus API error: ${res.status}`);
  const data = await res.json();
  if (data.code !== 1) throw new Error(`GoPlus error: ${data.message}`);

  const key = isSolana(chain) ? address : address.toLowerCase();
  const info = data.result?.[key];
  if (!info) return null;

  const holders = (info.holders ?? []).map((h, i) => ({
    rank: i + 1,
    address: h.address ?? h.account,
    percent: parseFloat((parseFloat(h.percent ?? 0) * 100).toFixed(2)),
    isContract: h.is_contract === 1,
    isLocked: h.is_locked === 1,
    tag: h.tag ?? null,
  }));

  const holderCount = parseInt(info.holder_count ?? 0);

  // GoPlus returned the token but with no holder data — signal to try fallback
  if (holderCount === 0 && holders.length === 0) return null;

  return { holderCount, holders };
}

/**
 * Fetch holder data from Solscan Pro API (Solana only).
 * Returns { holderCount, holders[] } or null if unavailable.
 */
async function fetchHoldersFromSolscan(address) {
  const chainCfg = getChain('solana');
  const apiKey = process.env[chainCfg.solana.solscan.apiKeyEnv];
  if (!apiKey) return null;

  const url = `${chainCfg.solana.solscan.baseUrl}/token/holders?address=${address}&page=1&page_size=40`;
  const res = await fetch(url, { headers: { token: apiKey } });
  if (!res.ok) {
    process.stderr.write(`Solscan API error: ${res.status}\n`);
    return null;
  }
  const data = await res.json();
  if (!data.success || !data.data) return null;

  const items = data.data.items ?? data.data.result ?? [];
  if (items.length === 0 && (data.data.total ?? 0) === 0) return null;

  const holders = items.map((h, i) => ({
    rank: h.rank ?? i + 1,
    address: h.owner ?? h.address,
    percent: parseFloat((parseFloat(h.percentage ?? 0) * 100).toFixed(2)),
    isContract: false,
    isLocked: false,
    tag: null,
  }));

  return { holderCount: data.data.total ?? holders.length, holders };
}

async function main() {
  const config = parseArgs();
  let chainCfg;
  try {
    chainCfg = getChain(config.chain);
  } catch {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Unsupported chain: ${config.chain}`,
      }),
    );
    process.exit(1);
  }

  try {
    // 1. Try GoPlus (works for all chains)
    let holderData = null;
    let source = 'goplus';
    try {
      holderData = await fetchHoldersFromGoPlus(config.address, config.chain, chainCfg);
    } catch (err) {
      process.stderr.write(`GoPlus holder fetch failed: ${err.message}\n`);
    }

    // 2. If GoPlus returned no holder data and this is Solana, try Solscan
    if (!holderData && isSolana(config.chain)) {
      try {
        holderData = await fetchHoldersFromSolscan(config.address);
        if (holderData) source = 'solscan';
      } catch (err) {
        process.stderr.write(`Solscan holder fetch failed: ${err.message}\n`);
      }
    }

    // 3. No data from any source
    if (!holderData) {
      console.log(
        JSON.stringify({
          status: 'no_holder_data',
          address: config.address,
          chain: config.chain,
          message: 'No holder distribution data available from any API source',
          source: 'none',
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    const { holderCount, holders } = holderData;

    const top10Percent = holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);
    const top5Percent = holders.slice(0, 5).reduce((sum, h) => sum + h.percent, 0);

    // Risk flags
    const flags = [];
    if (holders[0]?.percent > 30 && !holders[0]?.isContract && !holders[0]?.isLocked) {
      flags.push({ severity: 'critical', message: `Top holder owns ${holders[0].percent}% (not locked)` });
    }
    if (top10Percent > 50) {
      flags.push({ severity: 'high', message: `Top 10 holders own ${top10Percent.toFixed(1)}%` });
    }

    // Auto-propose top 5 non-contract, non-locked holders when --propose is set
    let walletsProposed = 0;
    if (config.propose) {
      try {
        const { getDb, close } = await import('./db.js');
        const db = getDb();
        const stmt = db.prepare(`
          INSERT OR IGNORE INTO tracked_wallets (address, chain, label, source, status)
          VALUES (?, ?, ?, 'holder_extraction', 'proposed')
        `);
        const proposable = holders.filter((h) => !h.isContract && !h.isLocked && h.address).slice(0, 5);
        const insertMany = db.transaction((list) => {
          for (const h of list) {
            const result = stmt.run(h.address, config.chain, `holder_rank${h.rank}_of_${config.address.slice(0, 8)}`);
            walletsProposed += result.changes;
          }
        });
        insertMany(proposable);
        close();
      } catch {
        // Non-fatal — propose is best-effort
      }
    }

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          address: config.address,
          chain: config.chain,
          source,
          totalHolders: holderCount,
          concentration: {
            top1: holders[0]?.percent ?? 0,
            top5: parseFloat(top5Percent.toFixed(2)),
            top10: parseFloat(top10Percent.toFixed(2)),
          },
          topHolders: holders.slice(0, 20),
          flags,
          ...(config.propose ? { walletsProposed } : {}),
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
      }),
    );
    process.exit(1);
  }
}

main();
