#!/usr/bin/env node
/**
 * portfolio-load-evm.js — Load on-chain portfolio from DeBank for EVM chains
 *
 * Fetches all token holdings for the Safe wallet address on a given chain,
 * then reconciles with DB positions. On-chain wins on conflicts.
 *
 * Usage:
 *   node scripts/portfolio-load-evm.js --chain base
 *   node scripts/portfolio-load-evm.js --chain base --trigger post_trade
 *   node scripts/portfolio-load-evm.js --chain base --trigger manual
 *
 * Requires: DEBANK_API_KEY, SAFE_ADDRESS_BASE (or chain-specific address env)
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getChain, isEVM } from './chains.js';

const DEBANK_BASE = 'https://pro-openapi.debank.com/v1';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: '', trigger: 'periodic' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--chain': config.chain = args[++i]; break;
      case '--trigger': config.trigger = args[++i]; break;
    }
  }
  if (!config.chain) {
    console.error('Error: --chain is required');
    process.exit(1);
  }
  return config;
}

async function fetchDebankTokenList(walletAddress, chainId, apiKey) {
  const url = `${DEBANK_BASE}/user/token_list?id=${walletAddress}&chain_id=${chainId}&is_all=false`;
  const res = await fetch(url, {
    headers: { AccessKey: apiKey },
  });
  if (!res.ok) {
    throw new Error(`DeBank API error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

function generateId() {
  return `pos-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const config = parseArgs();
  const { chain, trigger } = config;

  // Paper mode check
  if (process.env.PAPER_MODE === 'true') {
    console.log(JSON.stringify({
      status: 'skipped',
      reason: 'paper_mode',
      message: 'Portfolio sync skipped in paper mode — DB is sole source of truth',
    }, null, 2));
    return;
  }

  let chainCfg;
  try {
    chainCfg = getChain(chain);
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: err.message }));
    process.exit(1);
  }

  if (!isEVM(chain)) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Chain '${chain}' is not EVM. Use portfolio-load-solana.js for Solana.`,
    }));
    process.exit(1);
  }

  if (!chainCfg.portfolio?.provider || chainCfg.portfolio.provider !== 'debank') {
    console.log(JSON.stringify({
      status: 'error',
      error: `No portfolio provider configured for chain '${chain}'.`,
    }));
    process.exit(1);
  }

  const apiKey = process.env[chainCfg.portfolio.apiKeyEnv];
  if (!apiKey) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Missing ${chainCfg.portfolio.apiKeyEnv} environment variable.`,
    }));
    process.exit(1);
  }

  const walletAddress = process.env[chainCfg.safe.addressEnv];
  if (!walletAddress) {
    console.log(JSON.stringify({
      status: 'error',
      error: `Missing ${chainCfg.safe.addressEnv} environment variable.`,
    }));
    process.exit(1);
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: `DB init failed: ${err.message}` }));
    process.exit(1);
  }

  let syncResult = { positions_synced: 0, positions_closed: 0, positions_discovered: 0 };

  try {
    // 1. Fetch on-chain tokens from DeBank
    const onchainTokens = await fetchDebankTokenList(walletAddress, chainCfg.dexScreenerId, apiKey);

    // Build lookup: address -> on-chain token data
    const onchainMap = new Map();
    for (const token of onchainTokens) {
      if (!token.id || token.amount <= 0) continue;
      // DeBank uses lowercase addresses
      onchainMap.set(token.id.toLowerCase(), {
        address: token.id,
        symbol: token.symbol ?? 'UNKNOWN',
        name: token.name ?? token.symbol ?? 'Unknown',
        balance: token.amount,
        price: token.price ?? 0,
        value_usd: (token.amount ?? 0) * (token.price ?? 0),
      });
    }

    // 2. Load current DB positions for this chain
    const dbPositions = db.prepare(
      "SELECT * FROM positions WHERE chain = ? AND status IN ('open', 'partial_exit', 'pending_analysis')"
    ).all(chain);

    const now = new Date().toISOString();

    // 3. Reconcile: update existing, close missing, discover new
    const reconcile = db.transaction(() => {
      const matchedAddresses = new Set();

      for (const pos of dbPositions) {
        const addrKey = pos.address.toLowerCase();
        const onchain = onchainMap.get(addrKey);

        if (onchain && onchain.balance > 0) {
          // Match found — update quantity, value, balance
          matchedAddresses.add(addrKey);
          db.prepare(`
            UPDATE positions SET
              quantity = ?, value_usd = ?, onchain_balance = ?,
              current_price = ?, last_synced_at = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(onchain.balance, onchain.value_usd, onchain.balance, onchain.price, now, pos.id);
          syncResult.positions_synced++;
        } else {
          // On-chain balance is 0 but DB shows open → close
          matchedAddresses.add(addrKey);
          db.prepare(`
            UPDATE positions SET
              status = 'closed', onchain_balance = 0, last_synced_at = ?,
              notes = COALESCE(notes || ' | ', '') || 'Closed by on-chain sync: balance_zero_onchain',
              updated_at = datetime('now')
            WHERE id = ?
          `).run(now, pos.id);
          syncResult.positions_closed++;
        }
      }

      // 4. Discover on-chain tokens not in DB
      for (const [addrKey, token] of onchainMap) {
        if (matchedAddresses.has(addrKey)) continue;
        // Skip very small dust balances (< $1)
        if (token.value_usd < 1) continue;

        const stopLoss = token.price > 0 ? token.price * 0.5 : 0;
        const id = generateId();
        db.prepare(`
          INSERT INTO positions (id, symbol, name, address, chain, tier, entry_price, current_price,
            quantity, value_usd, stop_loss, take_profit_levels, status, onchain_balance, last_synced_at, notes)
          VALUES (?, ?, ?, ?, ?, 'moonshot', ?, ?, ?, ?, ?, '[]', 'pending_analysis', ?, ?, ?)
        `).run(
          id, token.symbol, token.name, token.address, chain,
          token.price, token.price, token.balance, token.value_usd,
          stopLoss, token.balance, now,
          'Auto-discovered on-chain — awaiting analysis'
        );
        syncResult.positions_discovered++;
      }

      // 5. Record sync result
      db.prepare(`
        INSERT INTO portfolio_sync (chain, provider, trigger, status, positions_synced, positions_closed, positions_discovered)
        VALUES (?, 'debank', ?, 'success', ?, ?, ?)
      `).run(chain, trigger, syncResult.positions_synced, syncResult.positions_closed, syncResult.positions_discovered);

      // 6. Update last sync timestamp
      db.prepare(`
        INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(`last_sync_${chain}`, now, now);
    });

    reconcile();

    console.log(JSON.stringify({
      status: 'ok',
      chain,
      trigger,
      provider: 'debank',
      wallet: walletAddress,
      onchain_tokens: onchainMap.size,
      ...syncResult,
      synced_at: now,
      timestamp: new Date().toISOString(),
    }, null, 2));

  } catch (err) {
    // Record failed sync
    try {
      db.prepare(`
        INSERT INTO portfolio_sync (chain, provider, trigger, status, error)
        VALUES (?, 'debank', ?, 'error', ?)
      `).run(chain, trigger, err.message);
    } catch { /* best effort */ }

    console.log(JSON.stringify({
      status: 'error',
      chain,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  } finally {
    close();
  }
}

main();
