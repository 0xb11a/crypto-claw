#!/usr/bin/env node
/**
 * backfill-squads-nonce.js — Recover safe_nonce for Squads receipts that were
 * written before the fix in writeReceipt() that persists squadsTransactionIndex.
 *
 * Strategy: each affected receipt has onchain_tx_hash set to the "metaSig" —
 * the signature of the tx that called vaultTransactionCreate + proposalCreate
 * + proposalApprove for a specific transactionIndex. Scan recent Squads
 * transaction indices, derive each index's Transaction PDA, pull its signature
 * history, and match against stuck receipts' onchain_tx_hash. When matched,
 * UPDATE safe_nonce.
 *
 * Usage:
 *   node scripts/backfill-squads-nonce.js                        # apply
 *   node scripts/backfill-squads-nonce.js --dry-run              # report only
 *   node scripts/backfill-squads-nonce.js --scan-depth 500       # override
 *   node scripts/backfill-squads-nonce.js --receipt rcpt-...     # single
 *
 * Env: SAFE_ID, SOLANA_RPC_URL, SQUADS_MULTISIG_ADDRESS
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { getChain } from './chains.js';
import { Connection, PublicKey } from '@solana/web3.js';
import * as multisig from '@sqds/multisig';
import { log } from './log.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { dryRun: false, scanDepth: 500, receiptId: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') config.dryRun = true;
    else if (args[i] === '--scan-depth') config.scanDepth = parseInt(args[++i], 10);
    else if (args[i] === '--receipt') config.receiptId = args[++i];
  }
  return config;
}

function resolveConfig() {
  const chain = getChain('solana');
  if (!chain.squads) throw new Error('Solana chain config missing squads section');
  const rpcUrl = process.env[chain.squads.rpcEnv];
  if (!rpcUrl) throw new Error(`${chain.squads.rpcEnv} not set`);
  const multisigAddress = process.env[chain.squads.multisigEnv];
  if (!multisigAddress) throw new Error(`${chain.squads.multisigEnv} not set (required for backfill)`);
  return {
    connection: new Connection(rpcUrl, 'confirmed'),
    multisigPda: new PublicKey(multisigAddress),
  };
}

function loadStuckReceipts(db, receiptId) {
  const base = `SELECT id, symbol, chain, status, onchain_tx_hash, safe_nonce, created_at
                FROM receipts
                WHERE status = 'queued_in_squads'
                  AND chain = 'solana'
                  AND safe_nonce IS NULL
                  AND onchain_tx_hash IS NOT NULL`;
  if (receiptId) {
    return db.prepare(`${base} AND id = ?`).all(receiptId);
  }
  return db.prepare(`${base} ORDER BY created_at DESC`).all();
}

async function scanIndexForSig(connection, multisigPda, index) {
  const [txPda] = multisig.getTransactionPda({ multisigPda, index: BigInt(index) });
  const sigs = await connection.getSignaturesForAddress(txPda, { limit: 10 });
  return sigs.map((s) => s.signature);
}

/**
 * Pure matcher — walks indices from maxIndex down to minIndex, calls fetchSigs(idx)
 * and matches returned signatures against receipts' onchain_tx_hash. Exits as soon
 * as all receipts are matched. Returns { matches, unmatched }.
 *
 * fetchSigs: async (idx: number) => string[]
 */
export async function matchReceiptsToIndices({ receipts, maxIndex, minIndex, fetchSigs, onError, delayMs = 0 }) {
  const sigToReceipt = new Map();
  for (const r of receipts) sigToReceipt.set(r.onchain_tx_hash, r);

  const matches = [];
  const remaining = new Set(sigToReceipt.keys());

  for (let idx = maxIndex; idx >= minIndex && remaining.size > 0; idx--) {
    let sigs;
    try {
      sigs = await fetchSigs(idx);
    } catch (err) {
      if (onError) onError(idx, err);
      continue;
    }
    for (const sig of sigs) {
      if (remaining.has(sig)) {
        const receipt = sigToReceipt.get(sig);
        matches.push({ receiptId: receipt.id, symbol: receipt.symbol, txIndex: idx, metaSig: sig });
        remaining.delete(sig);
      }
    }
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
  }

  const unmatched = [...remaining].map((sig) => {
    const r = sigToReceipt.get(sig);
    return { receiptId: r.id, symbol: r.symbol, metaSig: sig, created_at: r.created_at };
  });

  return { matches, unmatched };
}

export function applyBackfill(db, matches) {
  const stmt = db.prepare('UPDATE receipts SET safe_nonce = ? WHERE id = ? AND safe_nonce IS NULL');
  let updated = 0;
  for (const m of matches) {
    const res = stmt.run(m.txIndex, m.receiptId);
    if (res.changes > 0) updated++;
  }
  return updated;
}

async function main() {
  const args = parseArgs();
  const db = getDb();

  const receipts = loadStuckReceipts(db, args.receiptId);
  if (receipts.length === 0) {
    console.log(JSON.stringify({ status: 'ok', matched: 0, updated: 0, note: 'no stuck receipts' }));
    close();
    return;
  }

  const env = resolveConfig();
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(env.connection, env.multisigPda);
  const maxIndex = Number(multisigAccount.transactionIndex);
  const minIndex = Math.max(1, maxIndex - args.scanDepth + 1);

  log(
    'info',
    'backfill-squads-nonce',
    `scanning indices ${minIndex}..${maxIndex} for ${receipts.length} stuck receipts (dry_run=${args.dryRun})`,
  );

  const { matches, unmatched } = await matchReceiptsToIndices({
    receipts,
    maxIndex,
    minIndex,
    fetchSigs: (idx) => scanIndexForSig(env.connection, env.multisigPda, idx),
    onError: (idx, err) => log('warn', 'backfill-squads-nonce', `index ${idx} fetch failed: ${err.message}`),
    delayMs: 50,
  });

  for (const m of matches) {
    log('info', 'backfill-squads-nonce', `matched receipt=${m.receiptId} symbol=${m.symbol} → txIndex=${m.txIndex}`);
  }

  const updated = args.dryRun ? 0 : applyBackfill(db, matches);

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        dry_run: args.dryRun,
        scanned_range: { from: minIndex, to: maxIndex },
        total_stuck: receipts.length,
        matched: matches.length,
        updated,
        unmatched: unmatched.length,
        matches,
        unmatched_receipts: unmatched,
      },
      null,
      2,
    ),
  );

  if (unmatched.length > 0) {
    log(
      'warn',
      'backfill-squads-nonce',
      `${unmatched.length} receipts not matched within scan depth ${args.scanDepth} — increase --scan-depth or inspect manually`,
    );
  }

  close();
}

const invokedDirectly = import.meta.url === `file://${process.argv[1]}`;
if (invokedDirectly) {
  main().catch((err) => {
    log('error', 'backfill-squads-nonce', `failed: ${err.message}`);
    console.error(err.stack);
    close();
    process.exit(1);
  });
}
