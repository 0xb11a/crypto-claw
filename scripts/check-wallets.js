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
import { getDb, close } from './db.js';
import { getChain, isEVM, isSolana, getAllChains } from './chains.js';

// ============================================================
// CLI args
// ============================================================

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { positions: false, chain: null, type: null };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--positions': config.positions = true; break;
      case '--chain': config.chain = args[++i]; break;
      case '--type': config.type = args[++i]; break;
    }
  }
  return config;
}

// ============================================================
// EVM wallet check (Etherscan-compatible API)
// ============================================================

async function checkEvmWallet(address, chain) {
  let chainCfg;
  try { chainCfg = getChain(chain); } catch { return { address, chain, status: 'unsupported_chain' }; }
  if (!chainCfg.explorer) return { address, chain, status: 'unsupported_chain' };

  const apiKey = process.env[chainCfg.explorer.apiKeyEnv];
  if (!apiKey) {
    return { address, chain, status: 'no_api_key', message: `Set ${chainCfg.explorer.apiKeyEnv} to enable ${chain} wallet tracking` };
  }

  try {
    const url = `${chainCfg.explorer.baseUrl}?module=account&action=tokentx&address=${address}&page=1&offset=10&sort=desc&apikey=${apiKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== '1' || !Array.isArray(data.result)) {
      return { address, chain, status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.result.map(tx => ({
      hash: tx.hash,
      tokenSymbol: tx.tokenSymbol,
      tokenAddress: tx.contractAddress,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
      direction: tx.from.toLowerCase() === address.toLowerCase() ? 'sell' : 'buy',
    }));

    return {
      address,
      chain,
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
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

  return { address, chain: 'solana', status: 'no_api_key', message: 'Set SOLSCAN_API_KEY or HELIUS_API_KEY to enable Solana wallet tracking' };
}

async function checkSolanaViaSolscan(address, apiKey) {
  try {
    const url = `${getChain('solana').solana.solscan.baseUrl}/account/transactions?address=${address}&page_size=10`;
    const res = await fetch(url, { headers: { token: apiKey } });
    const data = await res.json();

    if (!data.success || !Array.isArray(data.data)) {
      return { address, chain: 'solana', status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.data.map(tx => ({
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
    return { address, chain: 'solana', status: 'error', error: err.message };
  }
}

async function checkSolanaViaHelius(address, apiKey) {
  try {
    const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${apiKey}&limit=10`;
    const res = await fetch(url);
    const data = await res.json();

    if (!Array.isArray(data)) {
      return { address, chain: 'solana', status: 'no_activity', recentTransactions: [] };
    }

    const txs = data.map(tx => ({
      hash: tx.signature,
      type: tx.type,
      timestamp: new Date((tx.timestamp ?? 0) * 1000).toISOString(),
      fee: tx.fee,
      description: tx.description,
    }));

    return {
      address,
      chain: 'solana',
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
    return { address, chain: 'solana', status: 'error', error: err.message };
  }
}

// ============================================================
// Unified check dispatcher
// ============================================================

async function checkWallet(address, chain) {
  if (isSolana(chain)) return checkSolanaWallet(address);
  if (isEVM(chain)) return checkEvmWallet(address, chain);
  return { address, chain, status: 'unsupported_chain', message: `Chain '${chain}' not supported. Supported: ${getAllChains().join(', ')}` };
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

  // Match tracked wallets whose notes reference a position's token address or symbol
  return allWallets.filter(w => {
    if (w.type === 'dev' || w.type === 'deployer') {
      return positions.some(p =>
        (w.notes && w.notes.toLowerCase().includes(p.address.toLowerCase())) ||
        (w.notes && w.notes.toLowerCase().includes(p.symbol.toLowerCase())) ||
        (w.chain === p.chain)
      );
    }
    return false;
  });
}

// ============================================================
// Main
// ============================================================

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

    // Apply filters
    if (config.chain) {
      wallets = wallets.filter(w => w.chain === config.chain);
    }
    if (config.type) {
      wallets = wallets.filter(w => w.type === config.type);
    }

    // --positions: narrow to wallets related to open positions
    let positionRelated = null;
    if (config.positions) {
      const related = getPositionRelatedWallets(db, wallets);
      positionRelated = related.map(w => ({ address: w.address, chain: w.chain, label: w.label, type: w.type }));
      // If --positions, only check position-related wallets
      if (related.length > 0) {
        const relatedKeys = new Set(related.map(w => `${w.address}:${w.chain}`));
        wallets = wallets.filter(w => relatedKeys.has(`${w.address}:${w.chain}`));
      }
    }

    if (wallets.length === 0) {
      console.log(JSON.stringify({
        status: 'ok',
        tracked: 0,
        recentActivity: 0,
        wallets: [],
        ...(positionRelated !== null ? { positionRelated } : {}),
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // Group by chain for per-chain rate limiting
    const byChain = {};
    for (const w of wallets) {
      (byChain[w.chain] ??= []).push(w);
    }

    // Check all chains concurrently, wallets within a chain sequentially (rate limit)
    const chainResults = await Promise.all(
      Object.entries(byChain).map(async ([chain, chainWallets]) => {
        const results = [];
        for (const wallet of chainWallets) {
          const activity = await checkWallet(wallet.address, chain);
          results.push({
            label: wallet.label,
            type: wallet.type,
            ...activity,
          });
          // Rate limit: 250ms between calls to same chain's API
          if (chainWallets.indexOf(wallet) < chainWallets.length - 1) {
            await new Promise(r => setTimeout(r, 250));
          }
        }
        return results;
      })
    );

    const results = chainResults.flat();

    // Find noteworthy activity (last hour)
    const noteworthy = results.filter(r =>
      r.recentTransactions?.some(tx => {
        const age = Date.now() - new Date(tx.timestamp).getTime();
        return age < 3_600_000;
      })
    );

    console.log(JSON.stringify({
      status: 'ok',
      tracked: wallets.length,
      recentActivity: noteworthy.length,
      wallets: results,
      ...(positionRelated !== null ? { positionRelated } : {}),
      timestamp: new Date().toISOString(),
    }, null, 2));
  } finally {
    close();
  }
}

main();
