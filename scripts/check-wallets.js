#!/usr/bin/env node
/**
 * check-wallets.js — Track smart money wallet activity across EVM + Solana
 *
 * Reads tracked wallets from SQLite (single source of truth).
 * Manage wallets via db-query.js: add-tracked-wallet, remove-tracked-wallet, get-tracked-wallets
 *
 * Usage:
 *   node scripts/check-wallets.js                     # Check all tracked wallets
 *   node scripts/check-wallets.js --chain base         # Filter to one chain
 *   node scripts/check-wallets.js --positions          # Only wallets related to open positions
 *   node scripts/check-wallets.js --type dev           # Filter by wallet type
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { getDb, close } from './db.js';
import { getChain, isEVM, isSolana, getAllChains } from './chains.js';
import { log } from './log.js';
import { sanitizeUntrusted } from './redact.js';
import { normalizeAddress } from './address-validator.js';

const FETCH_TIMEOUT_MS = Number(process.env.CHECK_WALLETS_FETCH_TIMEOUT_MS) || 5_000;
const DEFAULT_LIMIT_PER_CHAIN = Number(process.env.CHECK_WALLETS_LIMIT_PER_CHAIN) || 10;
const FAIL_FAST_CONSECUTIVE = 3;
const PER_CHAIN_DELAY_MS = 250;

// ============================================================
// Tx formatters — exported for unit tests.
//
// `tokenSymbol` (Etherscan) and `description`/`type` (Helius) are
// attacker-controlled fields: anyone can mint a token or build a
// transaction with arbitrary metadata. They must be sanitized before
// they cross into agent context (#6 address poisoning, #24 metadata
// prompt injection in the threat model).
// ============================================================

export function formatEvmTx(tx, walletAddress, chain = 'ethereum') {
  const tokenAddress = normalizeAddress(tx.contractAddress, chain);
  const from = normalizeAddress(tx.from, chain);
  const to = normalizeAddress(tx.to, chain);
  // If the wallet field itself is bad we can't compute direction safely.
  const wallet = normalizeAddress(walletAddress, chain);
  return {
    hash: tx.hash,
    tokenSymbol: sanitizeUntrusted(tx.tokenSymbol, { maxLen: 32 }),
    tokenAddress: tokenAddress ?? 'INVALID_ADDRESS',
    from: from ?? 'INVALID_ADDRESS',
    to: to ?? 'INVALID_ADDRESS',
    addressValid: tokenAddress !== null && from !== null && to !== null && wallet !== null,
    value: tx.value,
    timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
    direction: from && wallet && from.toLowerCase() === wallet.toLowerCase() ? 'sell' : 'buy',
  };
}

export function formatHeliusTx(tx) {
  return {
    hash: tx.signature,
    type: sanitizeUntrusted(tx.type, { maxLen: 32 }),
    timestamp: new Date((tx.timestamp ?? 0) * 1000).toISOString(),
    fee: tx.fee,
    description: sanitizeUntrusted(tx.description, { maxLen: 256 }),
  };
}

// ============================================================
// CLI args
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { positions: false, chain: null, type: null, limit: DEFAULT_LIMIT_PER_CHAIN };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--positions':
        config.positions = true;
        break;
      case '--chain':
        config.chain = args[++i];
        break;
      case '--type':
        config.type = args[++i];
        break;
      case '--limit':
        config.limit = Math.max(1, Number(args[++i]) || DEFAULT_LIMIT_PER_CHAIN);
        break;
    }
  }
  return config;
}

// ============================================================
// EVM wallet check (Etherscan-compatible API)
// ============================================================

async function checkEvmWallet(address, chain) {
  let chainCfg;
  try {
    chainCfg = getChain(chain);
  } catch (e) {
    log('warn', 'check-wallets', `getChain failed for ${chain} (wallet ${address}): ${e.message}`);
    return { address, chain, status: 'unsupported_chain' };
  }
  if (!chainCfg.explorer) return { address, chain, status: 'unsupported_chain' };

  const apiKey = process.env[chainCfg.explorer.apiKeyEnv];
  if (!apiKey) {
    return {
      address,
      chain,
      status: 'no_api_key',
      message: `Set ${chainCfg.explorer.apiKeyEnv} to enable ${chain} wallet tracking`,
    };
  }

  try {
    const url = `${chainCfg.explorer.baseUrl}?module=account&action=tokentx&address=${address}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return { address, chain, status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.result.map((tx) => formatEvmTx(tx, address, chain));

    return {
      address,
      chain,
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
    log('warn', 'check-wallets', `EVM wallet check failed for ${address} on ${chain}: ${err.message}`);
    return { address, chain, status: 'error', error: err.message };
  }
}

// ============================================================
// Solana wallet check (Solscan Pro or Helius)
// ============================================================

async function checkSolanaWallet(address) {
  const chainCfg = getChain('solana');
  const solscanKey = process.env[chainCfg.solana.solscan.apiKeyEnv];
  const heliusKey = process.env[chainCfg.solana.helius.apiKeyEnv];

  if (solscanKey) return checkSolanaViaSolscan(address, solscanKey);
  if (heliusKey) return checkSolanaViaHelius(address, heliusKey);

  return {
    address,
    chain: 'solana',
    status: 'no_api_key',
    message: 'Set SOLSCAN_API_KEY or HELIUS_API_KEY to enable Solana wallet tracking',
  };
}

async function checkSolanaViaSolscan(address, apiKey) {
  try {
    const url = `${getChain('solana').solana.solscan.baseUrl}/account/transactions?address=${address}&page_size=10`;
    const res = await fetch(url, {
      headers: { token: apiKey },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    const data = await res.json();

    if (!data.success || !Array.isArray(data.data)) {
      return { address, chain: 'solana', status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.data.map((tx) => ({
      hash: tx.tx_hash,
      timestamp: new Date((tx.block_time ?? 0) * 1000).toISOString(),
      status: tx.status,
      fee: tx.fee,
    }));

    return {
      address,
      chain: 'solana',
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
    log('warn', 'check-wallets', `Solscan wallet check failed for ${address}: ${err.message}`);
    return { address, chain: 'solana', status: 'error', error: err.message };
  }
}

async function checkSolanaViaHelius(address, apiKey) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=10`;
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    const data = await res.json();

    if (!Array.isArray(data)) {
      return { address, chain: 'solana', status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.map((tx) => formatHeliusTx(tx));

    return {
      address,
      chain: 'solana',
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
    log('warn', 'check-wallets', `Helius wallet check failed for ${address}: ${err.message}`);
    return { address, chain: 'solana', status: 'error', error: err.message };
  }
}

// ============================================================
// Unified check dispatcher
// ============================================================

async function checkWallet(address, chain) {
  if (isSolana(chain)) return checkSolanaWallet(address);
  if (isEVM(chain)) return checkEvmWallet(address, chain);
  return {
    address,
    chain,
    status: 'unsupported_chain',
    message: `Chain '${chain}' not supported. Supported: ${getAllChains().join(', ')}`,
  };
}

// ============================================================
// Position cross-reference
// ============================================================

function getPositionTokens(db) {
  const table = process.env.PAPER_MODE === 'true' ? 'paper_positions' : 'positions';
  return db.prepare(`SELECT address, chain, symbol FROM ${table} WHERE status IN ('open', 'partial_exit')`).all();
}

function getPositionRelatedWallets(db, allWallets) {
  const positions = getPositionTokens(db);
  if (positions.length === 0) return [];

  // Match dev/deployer wallets whose notes reference a position's address or symbol,
  // AND that are on the same chain as the referenced position (cheap pre-filter).
  return allWallets.filter((w) => {
    if (w.type !== 'dev' && w.type !== 'deployer') return false;
    if (!w.notes) return false;
    const notes = w.notes.toLowerCase();
    return positions.some(
      (p) => w.chain === p.chain && (notes.includes(p.address.toLowerCase()) || notes.includes(p.symbol.toLowerCase())),
    );
  });
}

// ============================================================
// Main
// ============================================================

// ============================================================
// Signal handling — emit partial JSON + structured log on SIGTERM
// so the operator knows what the script was doing when it was killed
// rather than seeing a bare "terminated by SIGTERM" in sentinel alerts.
// ============================================================

const RUN_STATE = {
  startedAt: Date.now(),
  totalScheduled: 0,
  byChainScheduled: {},
  byChainCompleted: {},
  currentByChain: {}, // chain -> { address, label, startedAt }
  results: [],
};

function emitTerminationJson(signal) {
  const elapsedMs = Date.now() - RUN_STATE.startedAt;
  const inflight = Object.entries(RUN_STATE.currentByChain).map(([chain, w]) => ({
    chain,
    address: w.address,
    label: w.label,
    elapsedMs: Date.now() - w.startedAt,
  }));
  log(
    'error',
    'check-wallets',
    `terminated by ${signal} after ${elapsedMs}ms — scheduled=${RUN_STATE.totalScheduled} ` +
      `completed=${RUN_STATE.results.length} inflight=${JSON.stringify(inflight)} ` +
      `byChain=${JSON.stringify(RUN_STATE.byChainCompleted)}/${JSON.stringify(RUN_STATE.byChainScheduled)}`,
  );
  try {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `terminated by ${signal} after ${elapsedMs}ms`,
        scheduled: RUN_STATE.totalScheduled,
        completed: RUN_STATE.results.length,
        inflight,
        byChainScheduled: RUN_STATE.byChainScheduled,
        byChainCompleted: RUN_STATE.byChainCompleted,
        wallets: RUN_STATE.results,
        timestamp: new Date().toISOString(),
      }),
    );
  } catch {}
  try {
    close();
  } catch {}
  process.exit(1);
}

process.on('SIGTERM', () => emitTerminationJson('SIGTERM'));
process.on('SIGINT', () => emitTerminationJson('SIGINT'));

async function main() {
  const config = parseArgs();
  let db;

  try {
    db = getDb();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: `DB init failed: ${err.message}` }));
    process.exit(1);
  }

  try {
    // Load scored wallets from SQLite (skip proposed/failed — not yet classified)
    let wallets = db.prepare("SELECT * FROM tracked_wallets WHERE status = 'scored' ORDER BY created_at DESC").all();
    const totalScored = wallets.length;

    // Apply filters
    if (config.chain) {
      wallets = wallets.filter((w) => w.chain === config.chain);
    }
    if (config.type) {
      wallets = wallets.filter((w) => w.type === config.type);
    }

    // --positions: narrow to wallets related to open positions
    let positionRelated = null;
    if (config.positions) {
      const related = getPositionRelatedWallets(db, wallets);
      positionRelated = related.map((w) => ({ address: w.address, chain: w.chain, label: w.label, type: w.type }));
      if (related.length > 0) {
        const relatedKeys = new Set(related.map((w) => `${w.address}:${w.chain}`));
        wallets = wallets.filter((w) => relatedKeys.has(`${w.address}:${w.chain}`));
      } else {
        wallets = [];
      }
    }

    // Group by chain and cap per-chain count to keep total wall time bounded.
    const byChain = {};
    for (const w of wallets) {
      (byChain[w.chain] ??= []).push(w);
    }
    const cappedByChain = {};
    let skippedByCap = 0;
    for (const [chain, list] of Object.entries(byChain)) {
      if (list.length > config.limit) {
        skippedByCap += list.length - config.limit;
        cappedByChain[chain] = list.slice(0, config.limit);
      } else {
        cappedByChain[chain] = list;
      }
    }

    const scheduledTotal = Object.values(cappedByChain).reduce((n, l) => n + l.length, 0);
    RUN_STATE.totalScheduled = scheduledTotal;
    for (const [chain, list] of Object.entries(cappedByChain)) {
      RUN_STATE.byChainScheduled[chain] = list.length;
      RUN_STATE.byChainCompleted[chain] = 0;
    }

    log(
      'info',
      'check-wallets',
      `start scored=${totalScored} filtered=${wallets.length} scheduled=${scheduledTotal} ` +
        `skippedByCap=${skippedByCap} positions=${config.positions} chain=${config.chain ?? 'all'} ` +
        `type=${config.type ?? 'all'} limitPerChain=${config.limit} fetchTimeoutMs=${FETCH_TIMEOUT_MS}`,
    );

    if (scheduledTotal === 0) {
      console.log(
        JSON.stringify({
          status: 'ok',
          tracked: 0,
          recentActivity: 0,
          wallets: [],
          ...(positionRelated !== null ? { positionRelated } : {}),
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    // Check all chains concurrently; wallets within a chain sequential (rate limit)
    // with per-chain fail-fast after FAIL_FAST_CONSECUTIVE consecutive errors/timeouts.
    const chainResults = await Promise.all(
      Object.entries(cappedByChain).map(async ([chain, chainWallets]) => {
        const results = [];
        let consecutiveFailures = 0;
        const chainStart = Date.now();

        for (let i = 0; i < chainWallets.length; i++) {
          const wallet = chainWallets[i];

          if (consecutiveFailures >= FAIL_FAST_CONSECUTIVE) {
            log(
              'warn',
              'check-wallets',
              `${chain}: fail-fast after ${consecutiveFailures} consecutive errors — ` +
                `skipping ${chainWallets.length - i} remaining wallet(s)`,
            );
            break;
          }

          const walletStart = Date.now();
          RUN_STATE.currentByChain[chain] = { address: wallet.address, label: wallet.label, startedAt: walletStart };
          log(
            'info',
            'check-wallets',
            `${chain}: [${i + 1}/${chainWallets.length}] ${wallet.label ?? wallet.address} start`,
          );

          const activity = await checkWallet(wallet.address, chain);
          const duration = Date.now() - walletStart;

          results.push({ label: wallet.label, type: wallet.type, ...activity });
          RUN_STATE.results.push({ label: wallet.label, type: wallet.type, ...activity });
          RUN_STATE.byChainCompleted[chain] = (RUN_STATE.byChainCompleted[chain] ?? 0) + 1;
          delete RUN_STATE.currentByChain[chain];

          if (activity.status === 'error' || activity.status === 'no_api_key') {
            consecutiveFailures++;
          } else {
            consecutiveFailures = 0;
          }

          log(
            'info',
            'check-wallets',
            `${chain}: [${i + 1}/${chainWallets.length}] ${wallet.label ?? wallet.address} ` +
              `done status=${activity.status} duration=${duration}ms`,
          );

          if (i < chainWallets.length - 1) {
            await new Promise((r) => setTimeout(r, PER_CHAIN_DELAY_MS));
          }
        }

        log(
          'info',
          'check-wallets',
          `${chain}: finished ${results.length}/${chainWallets.length} wallet(s) in ${Date.now() - chainStart}ms`,
        );
        return results;
      }),
    );

    const results = chainResults.flat();

    // Find noteworthy activity (last hour)
    const noteworthy = results.filter((r) =>
      r.recentTransactions?.some((tx) => {
        const age = Date.now() - new Date(tx.timestamp).getTime();
        return age < 3_600_000;
      }),
    );

    log(
      'info',
      'check-wallets',
      `done total=${Date.now() - RUN_STATE.startedAt}ms completed=${results.length}/${scheduledTotal} ` +
        `recentActivity=${noteworthy.length} skippedByCap=${skippedByCap}`,
    );

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          tracked: results.length,
          scheduled: scheduledTotal,
          skippedByCap,
          recentActivity: noteworthy.length,
          wallets: results,
          ...(positionRelated !== null ? { positionRelated } : {}),
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } finally {
    close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
