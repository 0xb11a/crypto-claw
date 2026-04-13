#!/usr/bin/env node
/**
 * portfolio-load-solana.js — Load on-chain portfolio from Squads vault
 *
 * Reads all SPL token holdings from the Squads vault address,
 * enriches with prices, and reconciles with DB positions.
 *
 * Usage:
 *   node scripts/portfolio-load-solana.js --chain solana
 *   node scripts/portfolio-load-solana.js --chain solana --trigger post_trade
 *
 * Requires: SQUADS_MULTISIG_ADDRESS, RPC_SOL
 * Optional: HELIUS_API_KEY (better token metadata via DAS API)
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getChain, isSolana, getStablecoins } from './chains.js';
import { Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import * as multisig from '@sqds/multisig';
import { log } from './log.js';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

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
    log('error', 'portfolio-load-solana', 'Missing required --chain argument');
    console.error('Error: --chain is required');
    process.exit(1);
  }
  return config;
}

function resolveVaultAddress(chainCfg) {
  if (!chainCfg.squads) throw new Error('Chain config missing squads section');

  const rpcUrl = process.env[chainCfg.squads.rpcEnv];
  if (!rpcUrl) throw new Error(`${chainCfg.squads.rpcEnv} not set`);

  // Direct vault address takes priority — no derivation needed
  const directVault = process.env[chainCfg.squads.vaultEnv];
  if (directVault) {
    return { connection: new Connection(rpcUrl, 'confirmed'), vaultPda: new PublicKey(directVault) };
  }

  // Fall back to deriving vault from multisig PDA
  const multisigAddress = process.env[chainCfg.squads.multisigEnv];
  if (!multisigAddress) throw new Error(`${chainCfg.squads.vaultEnv} or ${chainCfg.squads.multisigEnv} must be set`);

  const multisigPda = new PublicKey(multisigAddress);
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: chainCfg.squads.vaultIndex,
  });

  return { connection: new Connection(rpcUrl, 'confirmed'), vaultPda };
}

async function fetchTokenPrice(address) {
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/${address}`, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    if (pairs.length === 0) return null;
    const mainPair = pairs.sort((a, b) => parseFloat(b.liquidity?.usd ?? 0) - parseFloat(a.liquidity?.usd ?? 0))[0];
    const price = parseFloat(mainPair.priceUsd ?? 0);
    return price > 0 ? price : null;
  } catch (err) {
    log('warn', 'portfolio-load-solana', `Price fetch failed for token ${address}: ${err.message ?? err}`);
    return null;
  }
}

// Primary: Helius DAS API — getAssetsByOwner
async function fetchHeliusAssets(vaultAddress, apiKey, chainCfg, stablecoinAddresses) {
  const url = `https://mainnet.helius-rpc.com/?api-key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'crypto-claw',
      method: 'getAssetsByOwner',
      params: {
        ownerAddress: vaultAddress,
        displayOptions: { showFungible: true, showNativeBalance: true },
      },
    }),
  });

  if (!res.ok) throw new Error(`Helius API error: ${res.status}`);
  const data = await res.json();
  if (data.error) throw new Error(`Helius RPC error: ${data.error.message}`);

  const onchainMap = new Map();
  let cashBalance = 0;
  let gasBalance = null;

  for (const asset of data.result?.items ?? []) {
    if (asset.interface !== 'FungibleToken' && asset.interface !== 'FungibleAsset') continue;

    const mintAddress = asset.id;
    const balance = asset.token_info?.balance ?? 0;
    const decimals = asset.token_info?.decimals ?? 0;
    const humanBalance = balance / 10 ** decimals;

    if (humanBalance <= 0) continue;

    const symbol = asset.token_info?.symbol ?? asset.content?.metadata?.symbol ?? 'UNKNOWN';

    // Stablecoins → cash
    if (stablecoinAddresses.has(mintAddress)) {
      cashBalance += humanBalance;
      continue;
    }

    onchainMap.set(mintAddress, {
      address: mintAddress,
      symbol,
      name: asset.content?.metadata?.name ?? symbol,
      balance: humanBalance,
      price: 0,
      value_usd: 0,
    });
  }

  // Handle native SOL balance — gas only, not a position
  const nativeLamports = data.result?.nativeBalance?.lamports ?? 0;
  if (nativeLamports > 0) {
    const solBalance = nativeLamports / 1e9;
    gasBalance = { symbol: chainCfg.nativeToken.symbol, balance: solBalance, price: 0, value_usd: 0 };
  }

  return { onchainMap, cashBalance, gasBalance };
}

// Fallback: Raw RPC — getTokenAccountsByOwner (queries both Token and Token-2022 programs)
async function fetchRpcTokenAccounts(connection, vaultPda, chainCfg, stablecoinAddresses) {
  const [classicAccounts, token2022Accounts] = await Promise.all([
    connection.getTokenAccountsByOwner(vaultPda, { programId: TOKEN_PROGRAM_ID }),
    connection.getTokenAccountsByOwner(vaultPda, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  const allAccounts = [...classicAccounts.value, ...token2022Accounts.value];

  const onchainMap = new Map();
  let cashBalance = 0;
  let gasBalance = null;

  for (const { account } of allAccounts) {
    const data = account.data;
    // Parse SPL token account data (165 bytes minimum)
    const mint = new PublicKey(data.slice(0, 32));
    const amountBuf = data.slice(64, 72);
    const amount = amountBuf.readBigUInt64LE(0);

    if (amount === 0n) continue;

    const mintStr = mint.toString();

    // Stablecoins → cash (assume 6 decimals for USDC/USDT)
    if (stablecoinAddresses.has(mintStr)) {
      cashBalance += Number(amount) / 1e6;
      continue;
    }

    // Without Helius, we don't have metadata — use mint address as placeholder
    onchainMap.set(mintStr, {
      address: mintStr,
      symbol: mintStr.slice(0, 6) + '...',
      name: 'Unknown Token',
      balance: Number(amount), // raw amount — decimals unknown without metadata
      price: 0,
      value_usd: 0,
    });
  }

  // Get native SOL balance — gas only, not a position
  const solLamports = await connection.getBalance(vaultPda);
  if (solLamports > 0) {
    gasBalance = { symbol: chainCfg.nativeToken.symbol, balance: solLamports / 1e9, price: 0, value_usd: 0 };
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

  if (!isSolana(chain)) {
    console.log(
      JSON.stringify({
        status: 'error',
        error: `Chain '${chain}' is not Solana. Use portfolio-load-evm.js for EVM chains.`,
      }),
    );
    process.exit(1);
  }

  let vaultEnv;
  try {
    vaultEnv = resolveVaultAddress(chainCfg);
  } catch (err) {
    console.log(
      JSON.stringify(
        {
          status: 'error',
          error: err.message,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
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
  let provider = 'rpc';
  const stablecoinAddresses = getStablecoins(chain);

  try {
    // 1. Fetch on-chain tokens — Helius primary, RPC fallback
    let onchainMap;
    let cashBalance = 0;
    let gasBalance = null;

    const heliusKey = process.env[chainCfg.portfolio?.apiKeyEnv];
    if (heliusKey) {
      try {
        const result = await fetchHeliusAssets(vaultEnv.vaultPda.toString(), heliusKey, chainCfg, stablecoinAddresses);
        onchainMap = result.onchainMap;
        cashBalance = result.cashBalance;
        gasBalance = result.gasBalance;
        provider = 'helius';
      } catch (heliusErr) {
        log(
          'warn',
          'portfolio-load-solana',
          `Helius API failed for chain=${chain} vault=${vaultEnv.vaultPda.toString()}: ${heliusErr.message}, falling back to RPC`,
        );
        process.stderr.write(`Helius API failed (${heliusErr.message}), falling back to RPC`);
        onchainMap = null;
      }
    }

    if (!onchainMap) {
      const result = await fetchRpcTokenAccounts(vaultEnv.connection, vaultEnv.vaultPda, chainCfg, stablecoinAddresses);
      onchainMap = result.onchainMap;
      cashBalance = result.cashBalance;
      gasBalance = result.gasBalance;
      provider = 'rpc';
    }

    // 2. Enrich with DEXScreener prices
    for (const [, token] of onchainMap) {
      const price = await fetchTokenPrice(token.address);
      if (price !== null) {
        token.price = price;
        token.value_usd = token.balance * price;
      }
      await sleep(200);
    }

    // Price gas balance via wrapped native token
    if (gasBalance) {
      const price = await fetchTokenPrice(chainCfg.wrappedNativeToken.address);
      if (price !== null) {
        gasBalance.price = price;
        gasBalance.value_usd = gasBalance.balance * price;
      }
    }

    // 3. Load current DB positions for this chain
    const dbPositions = db
      .prepare("SELECT * FROM positions WHERE chain = ? AND status IN ('open', 'partial_exit', 'pending_analysis')")
      .all(chain);

    const now = new Date().toISOString();

    // 4. Reconcile
    const reconcile = db.transaction(() => {
      const matchedAddresses = new Set();

      for (const pos of dbPositions) {
        const addrKey = pos.address;
        const onchain = onchainMap.get(addrKey);

        if (onchain && onchain.balance > 0) {
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

      // 5. Discover on-chain tokens not in DB
      for (const [addrKey, token] of onchainMap) {
        if (matchedAddresses.has(addrKey)) continue;
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

      // 6. Sync stablecoin balance → per-chain cash
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

      // 6b. Sync native gas balance → per-chain gas metadata
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

      // 7. Record sync
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
          wallet: vaultEnv.vaultPda.toString(),
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
    try {
      db.prepare(
        `
        INSERT INTO portfolio_sync (chain, provider, trigger, status, error)
        VALUES (?, ?, ?, 'error', ?)
      `,
      ).run(chain, provider, trigger, err.message);
    } catch (dbErr) {
      log(
        'warn',
        'portfolio-load-solana',
        `Failed to record sync error in DB for chain=${chain}: ${dbErr.message ?? dbErr}`,
      );
    }

    log('error', 'portfolio-load-solana', `Portfolio sync failed for chain=${chain}: ${err.message}`);
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
