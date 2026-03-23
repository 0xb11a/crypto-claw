#!/usr/bin/env node
/**
 * track-multisig.js — Background multisig transaction tracker (no LLM required)
 *
 * Monitors queued Safe/Squads transactions, confirms or reverts draft positions.
 * Designed to run as a background loop (every 5 min, real mode only).
 *
 * Usage:
 *   node scripts/track-multisig.js
 *
 * Env vars: SAFE_ID, DB_PATH, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Output: JSON to stdout with { checked, confirmed, pending, failed }
 * Always exits 0.
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isSolana } from './chains.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REMINDER_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

// ============================================================
// Helpers
// ============================================================

function sendAlert(type, message) {
  try {
    const scriptPath = resolve(__dirname, 'send-alert.js');
    execSync(`node ${scriptPath} --type ${type} --agent tracker --message "${message.replace(/"/g, '\\"')}"`, {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: __dirname,
    });
  } catch {
    // alerting should never block tracking
  }
}

function syncPortfolio(chain) {
  try {
    const scriptName = isSolana(chain) ? 'portfolio-load-solana.js' : 'portfolio-load-evm.js';
    const scriptPath = resolve(__dirname, scriptName);
    execSync(`node ${scriptPath} --chain ${chain} --trigger post_trade`, {
      encoding: 'utf-8',
      timeout: 60_000,
      cwd: __dirname,
    });
  } catch {
    // sync failure should never block tracking
  }
}

function getCash(db, chain) {
  const key = `cash_${chain}`;
  const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(key);
  return row ? parseFloat(row.value || '0') : 0;
}

function setCash(db, chain, amount) {
  const key = `cash_${chain}`;
  db.prepare("UPDATE portfolio_meta SET value = ?, updated_at = datetime('now') WHERE key = ?").run(
    String(amount),
    key,
  );
}

// ============================================================
// Check on-chain status
// ============================================================

function checkSafeTransaction(chain, safeHash) {
  try {
    const scriptPath = resolve(__dirname, 'check-safe-status.js');
    const raw = execSync(`node ${scriptPath} --chain ${chain} --safe-hash ${safeHash}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: __dirname,
    });
    const data = JSON.parse(raw);
    if (data.status !== 'ok' || !data.transaction) return null;
    const tx = data.transaction;
    return {
      executed: tx.executed === true,
      successful: tx.isSuccessful === true,
      txHash: tx.txHash || null,
      confirmations: tx.confirmations?.length || 0,
      confirmationsRequired: tx.confirmationsRequired || 0,
    };
  } catch {
    return null;
  }
}

function checkSquadsTransaction(txIndex) {
  try {
    const scriptPath = resolve(__dirname, 'check-squads-status.js');
    const raw = execSync(`node ${scriptPath} --pending`, {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: __dirname,
    });
    const data = JSON.parse(raw);
    if (data.status !== 'ok') return null;
    const threshold = data.multisig?.threshold || 1;
    const pending = data.pendingTransactions?.transactions || [];
    const found = pending.find((t) => t.transactionIndex === txIndex);
    if (found) {
      // Still pending
      return {
        executed: false,
        successful: false,
        txHash: null,
        confirmations: found.approved || 0,
        confirmationsRequired: threshold,
      };
    }
    // Not in pending list — transaction was executed (or cancelled)
    return {
      executed: true,
      successful: true,
      txHash: null,
      confirmations: threshold,
      confirmationsRequired: threshold,
    };
  } catch {
    return null;
  }
}

// ============================================================
// Parse reminder timestamp from receipt notes
// ============================================================

function getLastReminder(notes) {
  if (!notes) return 0;
  const match = notes.match(/last_reminder:(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function setLastReminder(db, receiptId, now) {
  const receipt = db.prepare('SELECT notes FROM receipts WHERE id = ?').get(receiptId);
  const existing = receipt?.notes || '';
  const updated = existing.replace(/last_reminder:\d+/, '').trim();
  const newNotes = `${updated ? updated + ' ' : ''}last_reminder:${now}`.trim();
  db.prepare('UPDATE receipts SET notes = ?, created_at = created_at WHERE id = ?').run(newNotes, receiptId);
}

// ============================================================
// Handle confirmed transaction
// ============================================================

function handleConfirmed(db, receipt, position, txResult) {
  // Update receipt status
  db.prepare("UPDATE receipts SET status = 'executed', onchain_tx_hash = ? WHERE id = ?").run(
    txResult.txHash,
    receipt.id,
  );

  if (position.status === 'draft') {
    // BUY confirmed: activate position
    db.prepare("UPDATE positions SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(position.id);
    sendAlert('trade_executed', `Multisig confirmed: BUY $${receipt.symbol} — position activated`);
  } else if (position.status === 'pending_exit') {
    // SELL confirmed: close position
    db.prepare(
      `UPDATE positions SET status = 'closed', exit_date = date('now'), exit_reason = 'multisig_confirmed',
       updated_at = datetime('now') WHERE id = ?`,
    ).run(position.id);
    sendAlert('trade_executed', `Multisig confirmed: SELL $${receipt.symbol} — position closed`);
  }

  syncPortfolio(receipt.chain);
}

// ============================================================
// Handle rejected/failed transaction
// ============================================================

function handleRejected(db, receipt, position) {
  // Update receipt status
  db.prepare("UPDATE receipts SET status = 'reverted' WHERE id = ?").run(receipt.id);

  if (position.status === 'draft') {
    // BUY rejected: delete draft position, refund cash
    const cash = getCash(db, position.chain);
    setCash(db, position.chain, cash + (position.value_usd || 0));
    db.prepare('DELETE FROM positions WHERE id = ?').run(position.id);
    sendAlert('trade_failed', `Multisig rejected: BUY $${receipt.symbol} — draft reverted, cash refunded`);
  } else if (position.status === 'pending_exit') {
    // SELL rejected: revert position to open
    db.prepare("UPDATE positions SET status = 'open', updated_at = datetime('now') WHERE id = ?").run(position.id);
    sendAlert('trade_failed', `Multisig rejected: SELL $${receipt.symbol} — position reopened`);
  }
}

// ============================================================
// Handle still-pending transaction
// ============================================================

function handlePending(db, receipt, txResult) {
  const now = Date.now();
  const lastReminder = getLastReminder(receipt.notes);
  if (now - lastReminder >= REMINDER_INTERVAL_MS) {
    const sigs = `${txResult.confirmations}/${txResult.confirmationsRequired}`;
    sendAlert(
      'trade_executed',
      `Pending multisig: ${receipt.action.toUpperCase()} $${receipt.symbol} — ${sigs} signatures collected`,
    );
    setLastReminder(db, receipt.id, now);
  }
}

// ============================================================
// Main
// ============================================================

function main() {
  const db = getDb();
  const counts = { checked: 0, confirmed: 0, pending: 0, failed: 0 };

  try {
    // Find all queued receipts with linked positions
    const queuedReceipts = db
      .prepare(
        `SELECT * FROM receipts WHERE status IN ('queued_in_safe', 'queued_in_squads') AND position_id IS NOT NULL`,
      )
      .all();

    counts.checked = queuedReceipts.length;
    if (counts.checked === 0) {
      console.log(JSON.stringify(counts));
      return;
    }

    for (const receipt of queuedReceipts) {
      const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(receipt.position_id);
      if (!position) {
        // Orphaned receipt — position was deleted; mark receipt as reverted
        db.prepare("UPDATE receipts SET status = 'reverted', error = 'orphaned_position' WHERE id = ?").run(receipt.id);
        counts.failed++;
        continue;
      }

      // Check on-chain status
      let txResult;
      if (receipt.status === 'queued_in_safe') {
        if (!receipt.safe_tx_hash) {
          counts.failed++;
          continue;
        }
        txResult = checkSafeTransaction(receipt.chain, receipt.safe_tx_hash);
      } else {
        // queued_in_squads — use safe_nonce field as transaction index (or parse from notes)
        const txIndex = receipt.safe_nonce;
        if (!txIndex) {
          counts.failed++;
          continue;
        }
        txResult = checkSquadsTransaction(txIndex);
      }

      if (!txResult) {
        // Could not check status (API error) — skip, try next cycle
        counts.pending++;
        continue;
      }

      if (txResult.executed && txResult.successful) {
        handleConfirmed(db, receipt, position, txResult);
        counts.confirmed++;
      } else if (txResult.executed && !txResult.successful) {
        // Executed but reverted on-chain
        handleRejected(db, receipt, position);
        counts.failed++;
      } else {
        // Still pending
        handlePending(db, receipt, txResult);
        counts.pending++;
      }
    }
  } catch (err) {
    console.error(`track-multisig error: ${err.message}`);
  } finally {
    close();
  }

  console.log(JSON.stringify(counts));
}

main();
