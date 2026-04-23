#!/usr/bin/env node
/**
 * activity-wallets-bg.js — Background smart-money activity poller
 *
 * Polls a rotating slice of smart_money wallets for recent on-chain swaps and
 * writes one signal row per detected swap into smart_money_signals.
 *
 * Cycle (run by entrypoint.sh background loop, every 30 min):
 *   0. Prune signals older than 24 h
 *   1. Pick BATCH_SIZE wallets WHERE type='smart_money' AND status='scored'
 *      ordered by last_checked_at ASC NULLS FIRST (rotation)
 *   2. Group wallets by chain; chains run in parallel, wallets within a chain
 *      sequentially with PER_CHAIN_DELAY_MS between calls (rate limit respect)
 *   3. Per wallet: fetch tokentx (EVM) or parsed transactions (Solana) with a
 *      hard FETCH_TIMEOUT_MS per request. Group by tx_hash, identify swap legs
 *      (one stable/native side + one subject side), emit one signal per swap.
 *   4. INSERT OR IGNORE — UNIQUE constraint dedupes across cycles.
 *   5. Per-chain fail-fast: FAIL_FAST_CONSECUTIVE timeouts in a row → skip
 *      remaining wallets on that chain this cycle.
 *   6. Update last_checked_at on every wallet processed (success or skip).
 *   7. Write portfolio_meta.last_activity_wallets_bg_at — Observer reads this to detect
 *      a stalled bg loop.
 *
 * Consumers query via db-query.js get-smart-money-signals (Research → buys,
 * Sentinel → sells on held tokens).
 *
 * Usage:
 *   node scripts/activity-wallets-bg.js
 *
 * Environment:
 *   SAFE_ID / DB_PATH        — standard database config
 *   BASESCAN_API_KEY,        — EVM explorer API keys (one per active chain)
 *   ETHERSCAN_API_KEY
 *   HELIUS_API_KEY           — Solana parsed-transaction API
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getChain, isEVM, isSolana, getStablecoins } from './chains.js';
import { log } from './log.js';

const BATCH_SIZE = 10;
const FETCH_TIMEOUT_MS = 10_000;
const PER_CHAIN_DELAY_MS = 250;
const FAIL_FAST_CONSECUTIVE = 5;
const RETENTION_HOURS = 24;
const TOKENTX_OFFSET = 50; // recent transfers per wallet (covers ~25 swaps)

// ============================================================
// Fetch helpers (with hard timeout)
// ============================================================

async function fetchEvmTokenTxs(address, chain) {
  const chainCfg = getChain(chain);
  const apiKey = process.env[chainCfg.explorer.apiKeyEnv];
  if (!apiKey) {
    throw new Error(`${chainCfg.explorer.apiKeyEnv} not set`);
  }
  const url =
    `${chainCfg.explorer.baseUrl}?module=account&action=tokentx` +
    `&address=${address}&page=1&offset=${TOKENTX_OFFSET}&sort=desc&apikey=${apiKey}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const data = await res.json();
  if (data.status !== '1' || !Array.isArray(data.result)) return [];
  return data.result;
}

async function fetchSolanaTxs(address) {
  const heliusKey = process.env.HELIUS_API_KEY;
  if (!heliusKey) {
    throw new Error('HELIUS_API_KEY not set');
  }
  const url = `https://api.helius.xyz/v0/addresses/${address}/transactions?api-key=${heliusKey}&limit=${TOKENTX_OFFSET}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const data = await res.json();
  if (!Array.isArray(data)) return [];
  return data;
}

// ============================================================
// Swap extraction (per chain family)
// ============================================================

export function extractEvmSwaps(transfers, walletAddress, chain) {
  const stables = getStablecoins(chain); // Set of lowercase addresses
  const wnative = getChain(chain).wrappedNativeToken?.address?.toLowerCase();
  const isCounter = (addr) => {
    const a = addr.toLowerCase();
    return stables.has(a) || a === wnative;
  };

  // Group by tx_hash
  const byTx = new Map();
  for (const t of transfers) {
    if (!byTx.has(t.hash)) byTx.set(t.hash, []);
    byTx.get(t.hash).push(t);
  }

  const wallet = walletAddress.toLowerCase();
  const swaps = [];

  for (const [txHash, group] of byTx) {
    const ins = group.filter((t) => t.to.toLowerCase() === wallet);
    const outs = group.filter((t) => t.from.toLowerCase() === wallet);
    if (ins.length === 0 || outs.length === 0) continue;

    const counterIn = ins.find((t) => isCounter(t.contractAddress));
    const counterOut = outs.find((t) => isCounter(t.contractAddress));
    const subjectIn = ins.find((t) => !isCounter(t.contractAddress));
    const subjectOut = outs.find((t) => !isCounter(t.contractAddress));

    let action;
    let subject;
    let counter;
    if (counterOut && subjectIn) {
      action = 'buy';
      subject = subjectIn;
      counter = counterOut;
    } else if (subjectOut && counterIn) {
      action = 'sell';
      subject = subjectOut;
      counter = counterIn;
    } else {
      continue; // not a stable/native ↔ token swap
    }

    swaps.push({
      tx_hash: txHash,
      action,
      token_address: subject.contractAddress,
      token_symbol: subject.tokenSymbol,
      counter_token_address: counter.contractAddress,
      counter_token_symbol: counter.tokenSymbol,
      amount_token: subject.value,
      tx_timestamp: new Date(parseInt(subject.timeStamp, 10) * 1000).toISOString(),
    });
  }

  return swaps;
}

export function extractSolanaSwaps(txs, walletAddress, chain) {
  const stables = getStablecoins(chain); // Set of base58 addresses
  const wsol = getChain(chain).wrappedNativeToken?.address;
  const isCounter = (mint) => stables.has(mint) || mint === wsol;

  const swaps = [];
  for (const tx of txs) {
    if (tx.type !== 'SWAP') continue;
    if (!Array.isArray(tx.tokenTransfers)) continue;

    const ins = tx.tokenTransfers.filter((t) => t.toUserAccount === walletAddress);
    const outs = tx.tokenTransfers.filter((t) => t.fromUserAccount === walletAddress);
    if (ins.length === 0 || outs.length === 0) continue;

    const counterIn = ins.find((t) => isCounter(t.mint));
    const counterOut = outs.find((t) => isCounter(t.mint));
    const subjectIn = ins.find((t) => !isCounter(t.mint));
    const subjectOut = outs.find((t) => !isCounter(t.mint));

    let action;
    let subject;
    let counter;
    if (counterOut && subjectIn) {
      action = 'buy';
      subject = subjectIn;
      counter = counterOut;
    } else if (subjectOut && counterIn) {
      action = 'sell';
      subject = subjectOut;
      counter = counterIn;
    } else {
      continue;
    }

    const symFor = (t) => t.tokenSymbol || t.tokenName || (t.mint ? t.mint.slice(0, 8) : null);

    swaps.push({
      tx_hash: tx.signature,
      action,
      token_address: subject.mint,
      token_symbol: symFor(subject),
      counter_token_address: counter.mint,
      counter_token_symbol: symFor(counter),
      amount_token: String(subject.tokenAmount ?? ''),
      tx_timestamp: new Date((tx.timestamp ?? 0) * 1000).toISOString(),
    });
  }
  return swaps;
}

async function fetchWalletActivity(address, chain) {
  if (isSolana(chain)) {
    const txs = await fetchSolanaTxs(address);
    return extractSolanaSwaps(txs, address, chain);
  }
  if (isEVM(chain)) {
    const transfers = await fetchEvmTokenTxs(address, chain);
    return extractEvmSwaps(transfers, address, chain);
  }
  return [];
}

function isTimeoutError(err) {
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// ============================================================
// Main cycle
// ============================================================

async function main() {
  let db;
  try {
    db = getDb();
  } catch (err) {
    log('critical', 'activity-wallets-bg', `DB init failed: ${err.message}`);
    console.log(JSON.stringify({ status: 'error', error: `DB init failed: ${err.message}` }));
    process.exit(1);
  }

  try {
    // 0. Prune old signals (24 h retention)
    const pruned = db
      .prepare("DELETE FROM smart_money_signals WHERE created_at < datetime('now', ?)")
      .run(`-${RETENTION_HOURS} hours`).changes;

    // 1. Pick the next BATCH_SIZE smart_money wallets by oldest last_checked_at
    const wallets = db
      .prepare(
        `
      SELECT address, chain, label, score
      FROM tracked_wallets
      WHERE type = 'smart_money' AND status = 'scored'
      ORDER BY (last_checked_at IS NULL) DESC, last_checked_at ASC
      LIMIT ?
    `,
      )
      .all(BATCH_SIZE);

    const updateLastCheckedStmt = db.prepare(
      'UPDATE tracked_wallets SET last_checked_at = ? WHERE address = ? AND chain = ?',
    );
    const insertSignalStmt = db.prepare(`
      INSERT OR IGNORE INTO smart_money_signals
        (tx_hash, chain, wallet_address, wallet_score, wallet_label, action,
         token_address, token_symbol, counter_token_address, counter_token_symbol,
         amount_token, tx_timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const setBgHealthStmt = db.prepare(
      "INSERT OR REPLACE INTO portfolio_meta (key, value) VALUES ('last_activity_wallets_bg_at', ?)",
    );

    if (wallets.length === 0) {
      setBgHealthStmt.run(new Date().toISOString());
      log(
        'info',
        'activity-wallets-bg',
        `cycle: no smart_money wallets to check (pool empty — upstream pipeline may be stalled), pruned=${pruned}`,
      );
      console.log(
        JSON.stringify({
          status: 'ok',
          checked: 0,
          signals_written: 0,
          pruned,
          message: 'No smart_money wallets to check',
        }),
      );
      return;
    }

    // 2. Group by chain
    const byChain = {};
    for (const w of wallets) (byChain[w.chain] ??= []).push(w);

    // 3-5. Per chain: sequential with rate limit + fail-fast
    let totalChecked = 0;
    let totalSignals = 0;
    const chainResults = {};

    await Promise.all(
      Object.entries(byChain).map(async ([chain, chainWallets]) => {
        let consecutiveTimeouts = 0;
        let chainChecked = 0;
        let chainSignals = 0;
        let chainSkipped = 0;
        let chainTimeouts = 0;
        let chainErrors = 0;

        for (let i = 0; i < chainWallets.length; i++) {
          const wallet = chainWallets[i];

          if (consecutiveTimeouts >= FAIL_FAST_CONSECUTIVE) {
            chainSkipped = chainWallets.length - i;
            log(
              'warn',
              'activity-wallets-bg',
              `${chain}: fail-fast (${consecutiveTimeouts} consecutive timeouts), skipping ${chainSkipped} remaining wallets`,
            );
            break;
          }

          try {
            const swaps = await fetchWalletActivity(wallet.address, chain);
            for (const s of swaps) {
              const r = insertSignalStmt.run(
                s.tx_hash,
                chain,
                wallet.address,
                wallet.score,
                wallet.label,
                s.action,
                s.token_address,
                s.token_symbol,
                s.counter_token_address,
                s.counter_token_symbol,
                s.amount_token,
                s.tx_timestamp,
              );
              if (r.changes > 0) chainSignals++;
            }
            consecutiveTimeouts = 0;
          } catch (err) {
            if (isTimeoutError(err)) {
              consecutiveTimeouts++;
              chainTimeouts++;
              log(
                'warn',
                'activity-wallets-bg',
                `${chain}: fetch timeout for ${wallet.address} (consecutive: ${consecutiveTimeouts})`,
              );
            } else {
              consecutiveTimeouts = 0;
              chainErrors++;
              log('warn', 'activity-wallets-bg', `${chain}: fetch failed for ${wallet.address}: ${err.message}`);
            }
          }

          // Rotation: advance even on failure so a permanently dead wallet doesn't block forever
          updateLastCheckedStmt.run(new Date().toISOString(), wallet.address, chain);
          chainChecked++;

          // Rate limit between calls on same chain (skip after last)
          if (i < chainWallets.length - 1) {
            await new Promise((r) => setTimeout(r, PER_CHAIN_DELAY_MS));
          }
        }

        // Chain-dark detection: ran wallets, got no signals, and at least one fetch failed.
        // Catches the case where small batches never trip FAIL_FAST_CONSECUTIVE but the whole
        // chain is effectively down. Observer's "same warn shape >5x in 30 min" picks up sustained outages.
        if (chainChecked > 0 && chainSignals === 0 && (chainTimeouts > 0 || chainErrors > 0)) {
          log(
            'warn',
            'activity-wallets-bg',
            `${chain}: chain dark — checked=${chainChecked} signals=0 timeouts=${chainTimeouts} errors=${chainErrors}`,
          );
        }

        chainResults[chain] = {
          checked: chainChecked,
          signals: chainSignals,
          skipped: chainSkipped,
          timeouts: chainTimeouts,
          errors: chainErrors,
        };
        totalChecked += chainChecked;
        totalSignals += chainSignals;
      }),
    );

    // 7. Write bg health timestamp (observer reads this)
    setBgHealthStmt.run(new Date().toISOString());

    log(
      'info',
      'activity-wallets-bg',
      `cycle: checked=${totalChecked} signals=${totalSignals} pruned=${pruned} chains=${JSON.stringify(chainResults)}`,
    );

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          checked: totalChecked,
          signals_written: totalSignals,
          pruned,
          chains: chainResults,
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

// Only run main() when invoked as a script (not when imported by tests)
const invokedAsScript = import.meta.url === `file://${process.argv[1]}`;
if (invokedAsScript) {
  main();
}
