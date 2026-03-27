#!/usr/bin/env node
/**
 * emergency-executor.js — Script-only sell order executor (no LLM required)
 *
 * Runs when all model providers fail. Processes SELL orders only:
 *   1. Query orders table for pending approved sells
 *   2. For each sell order: call execute-trade-evm.js or execute-trade-solana.js
 *   3. On success: mark order executed, write receipt, update position
 *   4. In paper mode: simulate execution, write to paper tables
 *   5. Output JSON summary
 *
 * Deliberately excludes buy orders — automated buying without LLM reasoning
 * violates the safety model.
 *
 * Usage:
 *   node scripts/emergency-executor.js
 *
 * Env vars: SAFE_ID, DB_PATH, PAPER_MODE, plus all trade execution env vars
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { execSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPaper = process.env.PAPER_MODE === 'true';

const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';

// Chains that use Solana execution (Squads/Jupiter) vs EVM (Safe/1inch)
const SOLANA_CHAINS = new Set(['solana']);

function getPendingSells(db) {
  return db
    .prepare(
      `SELECT * FROM orders
       WHERE action = 'sell' AND status = 'approved'
       ORDER BY created_at ASC`,
    )
    .all();
}

function getPosition(db, address, chain) {
  const table = isPaper ? 'paper_positions' : 'positions';
  return db
    .prepare(`SELECT * FROM ${table} WHERE address = ? AND chain = ? AND status IN ('open', 'partial_exit')`)
    .get(address, chain);
}

async function fetchCurrentPrice(address) {
  try {
    const url = `${DEXSCREENER_BASE}/search?q=${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const pair = data.pairs?.[0];
    return pair ? parseFloat(pair.priceUsd ?? 0) : null;
  } catch {
    return null;
  }
}

function executeTradeLive(order) {
  const scriptName = SOLANA_CHAINS.has(order.chain) ? 'execute-trade-solana.js' : 'execute-trade-evm.js';
  const scriptPath = resolve(__dirname, scriptName);

  const args = [
    '--action',
    'sell',
    '--chain',
    order.chain,
    '--address',
    order.address,
    '--symbol',
    order.symbol,
    '--amount',
    order.amount || 'all',
    '--max-slippage',
    '5',
  ];

  const result = execSync(`node ${scriptPath} ${args.join(' ')}`, {
    encoding: 'utf-8',
    timeout: 120_000,
    env: process.env,
    cwd: __dirname,
  });

  return JSON.parse(result);
}

function simulatePaperSell(db, order, position, currentPrice) {
  const exitPrice = currentPrice || position.current_price || position.entry_price;
  const quantity = position.quantity || 0;
  const entryPrice = position.entry_price || 0;
  const pnlUsd = (exitPrice - entryPrice) * quantity;
  const pnlPercent = entryPrice > 0 ? ((exitPrice - entryPrice) / entryPrice) * 100 : 0;

  // Close paper position
  db.prepare(
    `UPDATE paper_positions SET status = 'closed', exit_price = ?, exit_reason = ?, pnl_usd = ?, pnl_percent = ?, exit_date = date('now'), updated_at = datetime('now') WHERE id = ?`,
  ).run(exitPrice, order.reason || 'emergency_sell', pnlUsd, pnlPercent, position.id);

  // Add sale proceeds to paper cash
  const saleProceeds = exitPrice * quantity;
  db.prepare(`UPDATE portfolio_meta SET value = CAST(CAST(value AS REAL) + ? AS TEXT) WHERE key = ?`).run(
    saleProceeds,
    `paper_cash_${position.chain}`,
  );

  // Write paper receipt
  const receiptId = `emg-rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO paper_receipts (id, order_id, action, symbol, address, chain, tier, proposed_price, quantity, amount, pnl_usd, pnl_percent, created_at)
     VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    receiptId,
    order.id,
    order.symbol,
    order.address,
    order.chain,
    position.tier || 'unknown',
    entryPrice,
    quantity,
    saleProceeds,
    pnlUsd,
    pnlPercent,
  );

  return {
    status: 'executed',
    mode: 'paper',
    receiptId,
    exitPrice,
    quantity,
    pnlUsd: parseFloat(pnlUsd.toFixed(2)),
    pnlPercent: parseFloat(pnlPercent.toFixed(2)),
  };
}

function markOrderExecuted(db, orderId) {
  db.prepare(
    `UPDATE orders SET status = 'executed', status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?`,
  ).run(orderId);
}

function writeReceipt(db, order, tradeResult) {
  const receiptId = `emg-rcpt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.prepare(
    `INSERT INTO receipts (id, order_id, action, symbol, address, chain, status, executed_price, slippage, onchain_tx_hash, created_at)
     VALUES (?, ?, 'sell', ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  ).run(
    receiptId,
    order.id,
    order.symbol,
    order.address,
    order.chain,
    tradeResult.status || 'executed',
    tradeResult.executedPrice || tradeResult.price || null,
    tradeResult.slippage || null,
    tradeResult.txHash || tradeResult.txSignature || null,
  );
  return receiptId;
}

function logToExecutor(db, summary) {
  db.prepare(
    `INSERT INTO executor_log (sell_orders_processed, buy_orders_processed, pending_checked, success_count, fail_count, status)
     VALUES (?, 0, ?, ?, ?, 'emergency')`,
  ).run(summary.sellsProcessed, summary.sellsFound, summary.sellsProcessed, summary.sellsFailed);
}

async function main() {
  const db = getDb();
  const pendingSells = getPendingSells(db);

  const result = {
    status: 'ok',
    mode: 'emergency',
    paperMode: isPaper,
    sellsFound: pendingSells.length,
    sellsProcessed: 0,
    sellsFailed: 0,
    results: [],
    errors: [],
    timestamp: new Date().toISOString(),
  };

  if (pendingSells.length === 0) {
    result.message = 'No pending sell orders';
    logToExecutor(db, result);
    console.log(JSON.stringify(result, null, 2));
    close();
    return;
  }

  for (const order of pendingSells) {
    try {
      const position = getPosition(db, order.address, order.chain);
      if (!position) {
        result.errors.push({ orderId: order.id, symbol: order.symbol, error: 'No matching open position' });
        result.sellsFailed++;
        continue;
      }

      let tradeResult;

      if (isPaper) {
        const currentPrice = await fetchCurrentPrice(order.address);
        tradeResult = simulatePaperSell(db, order, position, currentPrice);
      } else {
        tradeResult = executeTradeLive(order);
        if (tradeResult.status === 'failed') {
          result.errors.push({ orderId: order.id, symbol: order.symbol, error: tradeResult.error || 'Trade failed' });
          result.sellsFailed++;
          continue;
        }
        writeReceipt(db, order, tradeResult);
      }

      markOrderExecuted(db, order.id);
      result.sellsProcessed++;
      result.results.push({
        orderId: order.id,
        symbol: order.symbol,
        chain: order.chain,
        reason: order.reason,
        ...tradeResult,
      });
    } catch (err) {
      result.errors.push({ orderId: order.id, symbol: order.symbol, error: err.message });
      result.sellsFailed++;
    }
  }

  logToExecutor(db, result);
  console.log(JSON.stringify(result, null, 2));
  close();
}

main();
