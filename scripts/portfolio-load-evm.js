#!/usr/bin/env node
/**
 * portfolio-load-evm.js — Load on-chain portfolio for EVM chains
 *
 * Fetches all token holdings for the Safe wallet address on a given chain
 * (Safe TX Service primary, DeBank fallback), then reconciles with DB positions.
 * On-chain wins on conflicts.
 *
 * Usage:
 *   node scripts/portfolio-load-evm.js --chain base
 *   node scripts/portfolio-load-evm.js --chain base --trigger post_trade
 *   node scripts/portfolio-load-evm.js --chain base --trigger manual
 *
 * Requires: SAFE_ADDRESS_BASE (or chain-specific address env)
 * Optional: DEBANK_API_KEY (used as fallback if Safe API fails)
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getChain, isEVM, getStablecoins } from './chains.js';
import { formatUnits } from 'viem';
import { log } from './log.js';

const DEBANK_BASE = 'https://pro-openapi.debank.com/v1';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

async function fetchTokenPrice(address) {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/${address}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return null;
    // Highest-liquidity pair (same pattern as token-metrics.js)
    const mainPair = pairs.sort((a, b) => parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0))[0];
    const price = parseFloat(mainPair.priceUsd ?? 0);
    return price > 0 ? price : null;
  } catch (err) {
    log('warn', 'portfolio-load-evm', `Price fetch failed for token ${address}: ${err.message ?? err}`);
    return null;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: '', trigger: 'periodic' };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--chain':
        config.chain = args[++i];
        break;
      case '--trigger':
        config.trigger = args[++i];
        break;
    }
  }
  if (!config.chain) {
    log('error', 'portfolio-load-evm', 'Missing required --chain argument');
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

async function fetchSafeBalances(walletAddress, txServiceUrl, chainCfg, stablecoinAddresses) {
  const url = `${txServiceUrl}/api/v1/safes/${walletAddress}/balances/?trusted=false&exclude_spam=true`;
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Safe TX Service error: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();

  const onchainMap = new Map();
  let cashBalance = 0;
  let gasBalance = null;

  const nativeCfg = chainCfg.nativeToken;

  for (const entry of data) {
    if (entry.balance === '0') continue;

    // Native token (ETH/MATIC/etc) — tokenAddress is null → gas only, not a position
    if (!entry.tokenAddress) {
      const humanBalance = parseFloat(formatUnits(BigInt(entry.balance), nativeCfg.decimals));
      if (humanBalance > 0) {
        gasBalance = { symbol: nativeCfg.symbol, balance: humanBalance, price: 0, value_usd: 0 };
      }
      continue;
    }

    const decimals = entry.token?.decimals ?? 18;
    const humanBalance = parseFloat(formatUnits(BigInt(entry.balance), decimals));
    if (humanBalance <= 0) continue;

    // Stablecoins → cash balance, not a position
    if (stablecoinAddresses.has(entry.tokenAddress.toLowerCase())) {
      cashBalance += humanBalance;
      continue;
    }

    const symbol = entry.token?.symbol ?? 'UNKNOWN';

    onchainMap.set(entry.tokenAddress.toLowerCase(), {
      address: entry.tokenAddress,
      symbol,
      name: entry.token?.name ?? symbol ?? 'Unknown',
      balance: humanBalance,
      price: 0,
      value_usd: 0,
    });
  }

  // Enrich tokens with DEXScreener prices
  for (const [, token] of onchainMap) {
    const price = await fetchTokenPrice(token.address);
    if (price !== null) {
      token.price = price;
      token.value_usd = token.balance * price;
    }
    await sleep(200); // Rate limit (same as check-positions.js)
  }

  // Price gas balance via wrapped native token
  if (gasBalance) {
    const price = await fetchTokenPrice(chainCfg.wrappedNativeToken.address);
    if (price !== null) {
      gasBalance.price = price;
      gasBalance.value_usd = gasBalance.balance * price;
    }
  }

  return { onchainMap, cashBalance, gasBalance };
}

function generateId() {
  return `pos-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main() {
  const config = parseArgs();
  const { chain, trigger } = config;

  // Paper mode check
  if (process.env.PAPER_MODE === 'true') {
    console.log(
      JSON.stringify(
        {
          status: 'skipped',
          reason: 'paper_mode',
          message: 'Portfolio sync skipped in paper mode — DB is sole source of truth',
        },
        null,
        2,
      ),
    );
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
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Chain '${chain}' is not EVM. Use portfolio-load-solana.js for Solana.`,
      }),
    );
    process.exit(1);
  }

  const walletAddress = process.env[chainCfg.safe.addressEnv];
  if (!walletAddress) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Missing ${chainCfg.safe.addressEnv} environment variable.`,
      }),
    );
    process.exit(1);
  }

  let db;
  try {
    db = getDb();
  } catch (err) {
    console.log(JSON.stringify({ status: 'error', error: `DB init failed: ${err.message}` }));
    process.exit(1);
  }

  const syncResult = { positions_synced: 0, positions_closed: 0, positions_discovered: 0, cash_synced: 0 };
  let provider;
  const stablecoinAddresses = getStablecoins(chain);

  try {
    // 1. Fetch on-chain tokens — Safe TX Service primary, DeBank fallback
    let onchainMap;
    let cashBalance = 0;
    let gasBalance = null;

    const txServiceUrl = chainCfg.safe?.txServiceUrl;
    if (txServiceUrl) {
      try {
        const result = await fetchSafeBalances(walletAddress, txServiceUrl, chainCfg, stablecoinAddresses);
        onchainMap = result.onchainMap;
        cashBalance = result.cashBalance;
        gasBalance = result.gasBalance;
        if (onchainMap.size === 0 && cashBalance === 0) throw new Error('Safe API returned 0 tokens');
        provider = 'safe';
      } catch (safeErr) {
        // Fall through to DeBank
        onchainMap = null;
        log(
          'warn',
          'portfolio-load-evm',
          `Safe API failed for chain=${chain} wallet=${walletAddress}: ${safeErr.message}, falling back to DeBank`,
        );
        process.stderr.write(`Safe API failed (${safeErr.message}), falling back to DeBank`);
      }
    }

    if (!onchainMap) {
      // DeBank fallback
      const apiKey = process.env[chainCfg.portfolio?.apiKeyEnv];
      if (!apiKey) {
        throw new Error(
          `Safe API unavailable and missing ${chainCfg.portfolio?.apiKeyEnv ?? 'DEBANK_API_KEY'} for fallback`,
        );
      }
      const onchainTokens = await fetchDebankTokenList(walletAddress, chainCfg.dexScreenerId, apiKey);
      onchainMap = new Map();
      const nativeSymbol = chainCfg.nativeToken.symbol;
      for (const token of onchainTokens) {
        if (token.amount <= 0) continue;

        // Native token — gas only, not a position
        if (!token.id || token.is_native_token) {
          gasBalance = {
            symbol: nativeSymbol,
            balance: token.amount,
            price: token.price ?? 0,
            value_usd: (token.amount ?? 0) * (token.price ?? 0),
          };
          continue;
        }

        // Stablecoins → cash balance
        if (stablecoinAddresses.has(token.id.toLowerCase())) {
          cashBalance += token.amount;
          continue;
        }

        onchainMap.set(token.id.toLowerCase(), {
          address: token.id,
          symbol: token.symbol ?? 'UNKNOWN',
          name: token.name ?? token.symbol ?? 'Unknown',
          balance: token.amount,
          price: token.price ?? 0,
          value_usd: (token.amount ?? 0) * (token.price ?? 0),
        });
      }
      provider = 'debank';
    }

    // 2. Load current DB positions for this chain
    const dbPositions = db
      .prepare("SELECT * FROM positions WHERE chain = ? AND status IN ('open', 'partial_exit', 'pending_analysis')")
      .all(chain);

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
          db.prepare(
            `
            UPDATE positions SET
              quantity = ?, value_usd = ?, onchain_balance = ?,
              current_price = ?, last_synced_at = ?, updated_at = datetime('now')
            WHERE id = ?
          `,
          ).run(onchain.balance, onchain.value_usd, onchain.balance, onchain.price, now, pos.id);
          syncResult.positions_synced++;
        } else {
          // On-chain balance is 0 but DB shows open → close
          matchedAddresses.add(addrKey);
          db.prepare(
            `
            UPDATE positions SET
              status = 'closed', onchain_balance = 0, last_synced_at = ?,
              exit_reason = 'onchain_sync_zero_balance', exit_date = date('now'),
              notes = COALESCE(notes || ' | ', '') || 'Closed by on-chain sync: balance_zero_onchain',
              updated_at = datetime('now')
            WHERE id = ?
          `,
          ).run(now, pos.id);
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
        db.prepare(
          `
          INSERT INTO positions (id, symbol, name, address, chain, tier, entry_price, current_price,
            quantity, value_usd, stop_loss, take_profit_levels, status, onchain_balance, last_synced_at, notes)
          VALUES (?, ?, ?, ?, ?, 'moonshot', ?, ?, ?, ?, ?, '[]', 'pending_analysis', ?, ?, ?)
        `,
        ).run(
          id,
          token.symbol,
          token.name,
          token.address,
          chain,
          token.price,
          token.price,
          token.balance,
          token.value_usd,
          stopLoss,
          token.balance,
          now,
          'Auto-discovered on-chain — awaiting analysis',
        );
        syncResult.positions_discovered++;
      }

      // 5. Sync stablecoin balance → per-chain cash
      if (cashBalance > 0) {
        const chainCashKey = `cash_${chain}`;
        db.prepare(
          `
          INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
        `,
        ).run(chainCashKey, cashBalance.toString(), cashBalance.toString());
        syncResult.cash_synced = cashBalance;
      }

      // 5b. Sync native gas balance → per-chain gas metadata
      if (gasBalance) {
        const gasKey = `gas_${chain}`;
        const gasJson = JSON.stringify(gasBalance);
        db.prepare(
          `
          INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
          ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
        `,
        ).run(gasKey, gasJson, gasJson);
      }

      // 6. Record sync result
      db.prepare(
        `
        INSERT INTO portfolio_sync (chain, provider, trigger, status, positions_synced, positions_closed, positions_discovered)
        VALUES (?, ?, ?, 'success', ?, ?, ?)
      `,
      ).run(
        chain,
        provider,
        trigger,
        syncResult.positions_synced,
        syncResult.positions_closed,
        syncResult.positions_discovered,
      );

      // 7. Update last sync timestamp
      db.prepare(
        `
        INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `,
      ).run(`last_sync_${chain}`, now, now);
    });

    reconcile();

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          chain,
          trigger,
          provider,
          wallet: walletAddress,
          onchain_tokens: onchainMap.size,
          ...syncResult,
          gas_balance: gasBalance,
          synced_at: now,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch (err) {
    // Record failed sync
    try {
      db.prepare(
        `
        INSERT INTO portfolio_sync (chain, provider, trigger, status, error)
        VALUES (?, ?, ?, 'error', ?)
      `,
      ).run(chain, provider ?? 'unknown', trigger, err.message);
    } catch (dbErr) {
      log(
        'warn',
        'portfolio-load-evm',
        `Failed to record sync error in DB for chain=${chain}: ${dbErr.message ?? dbErr}`,
      );
    }

    log('error', 'portfolio-load-evm', `Portfolio sync failed for chain=${chain}: ${err.message}`);
    console.log(
      JSON.stringify({
        status: 'error',
        chain,
        error: err.message,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  } finally {
    close();
  }
}

main();
