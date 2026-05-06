#!/usr/bin/env node
/**
 * reconcile-positions.js — Periodic on-chain reconciliation pass (PR 3.3)
 *
 * Defense-in-depth on top of PR 2.6 (post-buy balance assertion).
 * PR 2.6 catches drift at the moment of buy. PR 3.3 catches drift
 * that emerges AFTER the buy:
 *   - Continuous fee-on-transfer / rebase tokens slowly draining
 *   - Solana freeze authority confiscating the position
 *   - Backdoor mint diluting our holdings
 *   - Anyone who happens to set the wrong number in a sync bug
 *
 * For each open position, fetches the actual on-chain balance from
 * the Safe / Squads vault and compares to positions.quantity. Drift
 * > 1% writes a `recon_drift_X.YYpct` marker into positions.notes
 * and emits an alert in the JSON output. Sentinel reads the output
 * and surfaces the alert via Telegram. We do NOT auto-sell — by the
 * time drift is detected, the damage is done; selling now is
 * decided by the operator.
 *
 * Skipped in paper mode (no on-chain state). Default cadence: 60 min
 * via run_position_reconcile_loop in entrypoint.sh.
 *
 * Usage:
 *   node scripts/reconcile-positions.js
 *   node scripts/reconcile-positions.js --address 0x... --chain base   # one position
 */

import 'dotenv/config';
import { fileURLToPath } from 'node:url';
import { getDb, close } from './db.js';
import { getChain, isEVM, isSolana } from './chains.js';
import { log } from './log.js';
import { fetchOnchainTokenBalance, fetchTokenDecimals, evaluatePositionDrift } from './onchain-balance.js';
import { sanitizeUntrusted } from './redact.js';

const isPaper = process.env.PAPER_MODE === 'true';

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

function loadOpenPositions(db, filter = {}) {
  const conditions = ["status IN ('open', 'partial_exit')"];
  const params = [];
  if (filter.address) {
    conditions.push('address = ?');
    params.push(filter.address);
  }
  if (filter.chain) {
    conditions.push('chain = ?');
    params.push(filter.chain);
  }
  const sql = `SELECT id, symbol, address, chain, quantity, notes FROM positions WHERE ${conditions.join(' AND ')}`;
  return db.prepare(sql).all(...params);
}

/**
 * Resolve the wallet address holding the position for a chain. EVM:
 * Safe address from env. Solana: vault from env or derived from
 * multisig. Same logic onchain-balance.js uses internally for cash.
 */
async function getVaultAddress(chainName) {
  const chain = getChain(chainName);
  if (isEVM(chainName)) {
    return process.env[chain.safe.addressEnv];
  }
  if (isSolana(chainName)) {
    let v = process.env[chain.squads.vaultEnv];
    if (!v) {
      const m = process.env[chain.squads.multisigEnv];
      if (!m) return null;
      const multisig = await import('@sqds/multisig');
      const { PublicKey } = await import('@solana/web3.js');
      const [pda] = multisig.getVaultPda({
        multisigPda: new PublicKey(m),
        index: chain.squads.vaultIndex ?? 0,
      });
      v = pda.toBase58();
    }
    return v;
  }
  return null;
}

async function reconcileOne(db, position) {
  const result = {
    id: position.id,
    symbol: position.symbol,
    address: position.address,
    chain: position.chain,
    dbQty: position.quantity,
    onchainQty: null,
    drift: null,
    error: null,
  };

  let owner;
  try {
    owner = await getVaultAddress(position.chain);
    if (!owner) throw new Error(`vault_address_not_resolved for chain ${position.chain}`);
  } catch (err) {
    result.error = `vault_lookup_failed: ${err.message.slice(0, 100)}`;
    return result;
  }

  let decimals;
  try {
    decimals = await fetchTokenDecimals(position.chain, position.address);
  } catch (err) {
    result.error = `decimals_fetch_failed: ${err.message.slice(0, 100)}`;
    return result;
  }

  let onchainQty;
  try {
    onchainQty = await fetchOnchainTokenBalance(position.chain, position.address, owner, decimals);
  } catch (err) {
    result.error = `balance_fetch_failed: ${err.message.slice(0, 100)}`;
    return result;
  }
  result.onchainQty = onchainQty;

  const drift = evaluatePositionDrift({ dbQty: position.quantity, onchainQty });
  result.drift = drift;

  if (!drift.valid) {
    // Append marker to positions.notes — Sentinel surfaces this and
    // the operator can act. We use append (not replace) so multiple
    // reconcile passes leave a trail; if notes grows unbounded the
    // operator can prune manually.
    const ts = new Date().toISOString().slice(0, 19);
    const marker =
      `[${ts}] recon_drift_${drift.driftPct.toFixed(2)}pct ` +
      `direction=${drift.direction} db=${position.quantity} onchain=${onchainQty}`;
    // sanitize the existing notes before concatenation in case it
    // already contains attacker-controlled strings (defense in depth)
    const existing = sanitizeUntrusted(position.notes ?? '', { maxLen: 800 });
    const newNotes = existing ? `${existing}\n${marker}` : marker;
    try {
      db.prepare("UPDATE positions SET notes = ?, updated_at = datetime('now') WHERE id = ?").run(
        newNotes,
        position.id,
      );
    } catch (err) {
      log('warn', 'reconcile-positions', `notes_write_failed for ${position.id}: ${err.message}`);
    }
    log(
      'critical',
      'reconcile-positions',
      `position_drift ${position.symbol} (${position.id}) on ${position.chain}: db=${position.quantity} onchain=${onchainQty} drift=${drift.driftPct.toFixed(2)}% direction=${drift.direction}`,
    );
  }

  return result;
}

async function main() {
  if (isPaper) {
    console.log(JSON.stringify({ status: 'skipped', reason: 'paper_mode', timestamp: new Date().toISOString() }));
    return;
  }

  const db = getDb();
  try {
    const positions = loadOpenPositions(db, { address: getArg('address'), chain: getArg('chain') });

    if (positions.length === 0) {
      console.log(
        JSON.stringify({
          status: 'ok',
          totalPositions: 0,
          driftCount: 0,
          alerts: [],
          timestamp: new Date().toISOString(),
        }),
      );
      return;
    }

    const results = [];
    for (const pos of positions) {
      const r = await reconcileOne(db, pos);
      results.push(r);
      // Light rate limit between RPC calls.
      await new Promise((r) => setTimeout(r, 200));
    }

    const drifted = results.filter((r) => r.drift && !r.drift.valid);
    const errors = results.filter((r) => r.error);

    console.log(
      JSON.stringify(
        {
          status: 'ok',
          totalPositions: results.length,
          driftCount: drifted.length,
          errorCount: errors.length,
          alerts: drifted.map((d) => ({
            id: d.id,
            symbol: d.symbol,
            chain: d.chain,
            dbQty: d.dbQty,
            onchainQty: d.onchainQty,
            driftPct: d.drift.driftPct,
            direction: d.drift.direction,
          })),
          errors: errors.map((e) => ({ id: e.id, symbol: e.symbol, chain: e.chain, error: e.error })),
          positions: results,
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
