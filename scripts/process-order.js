#!/usr/bin/env node
/**
 * process-order.js — Deterministic order executor (no LLM required)
 *
 * Processes a single approved order: validate, execute, receipt, position, cash, mark done, alert.
 * Replaces the LLM-driven multi-step procedure with a single atomic script.
 *
 * Usage:
 *   node scripts/process-order.js --order-id <ID>
 *
 * Env vars: SAFE_ID, DB_PATH, PAPER_MODE, SAFE_SIGNER_KEY (real EVM),
 *           SQUADS_SIGNER_KEY (real Solana), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Output: JSON to stdout with { ok, order_id, action, status, receipt_id, ... }
 * Always exits 0 — errors reported in JSON output.
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { execSync, execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isSolana } from './chains.js';
import { log } from './log.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPaper = process.env.PAPER_MODE === 'true';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const STALE_PRICE_THRESHOLD = 0.1; // 10% drift = stale
const MAX_RETRIES = 3;
const TRANSIENT_ERRORS = ['Too Many Requests', '429', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'socket hang up'];

// ============================================================
// CLI
// ============================================================

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// Data access helpers
// ============================================================

function loadOrder(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: `Order not found: ${orderId}` };
  if (order.status !== 'approved') return { error: `Order status is '${order.status}', expected 'approved'` };
  if (order.take_profit_levels) {
    try {
      order.take_profit_levels_parsed = JSON.parse(order.take_profit_levels);
    } catch {
      order.take_profit_levels_parsed = [];
    }
  }
  return { order };
}

function isTransientError(errorMsg) {
  return TRANSIENT_ERRORS.some((pattern) => errorMsg.includes(pattern));
}

function getRetryCount(db, orderId) {
  const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`retry_${orderId}`);
  return row ? parseInt(row.value, 10) : 0;
}

function setRetryCount(db, orderId, count) {
  db.prepare(
    "INSERT INTO portfolio_meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
  ).run(`retry_${orderId}`, String(count), String(count));
}

function clearRetryCount(db, orderId) {
  db.prepare('DELETE FROM portfolio_meta WHERE key = ?').run(`retry_${orderId}`);
}

function markRetry(db, orderId, reason, retryNum) {
  db.prepare(
    "UPDATE orders SET status_reason = ?, status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(`retry ${retryNum}/${MAX_RETRIES}: ${reason}`, orderId);
}

function getPosition(db, address, chain) {
  const table = isPaper ? 'paper_positions' : 'positions';
  return db
    .prepare(`SELECT * FROM ${table} WHERE address = ? AND chain = ? AND status IN ('open', 'partial_exit')`)
    .get(address, chain);
}

function getCash(db, chain) {
  const key = isPaper ? `paper_cash_${chain}` : `cash_${chain}`;
  const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(key);
  return row ? parseFloat(row.value || '0') : 0;
}

function setCash(db, chain, amount) {
  const key = isPaper ? `paper_cash_${chain}` : `cash_${chain}`;
  db.prepare("UPDATE portfolio_meta SET value = ?, updated_at = datetime('now') WHERE key = ?").run(
    String(amount),
    key,
  );
}

// ============================================================
// Price fetching
// ============================================================

async function fetchCurrentPrice(address, chain) {
  // Try token-metrics.js first (more reliable)
  try {
    const scriptPath = resolve(__dirname, 'token-metrics.js');
    const raw = execSync(`node ${scriptPath} --address ${address} --chain ${chain}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: __dirname,
    });
    const data = JSON.parse(raw);
    if (data.price > 0) return data.price;
  } catch {
    // fall through to DEXScreener
  }

  // Fallback: DEXScreener
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    const chainPairs = pairs.filter((p) => p.chainId === chain);
    const best = (chainPairs.length > 0 ? chainPairs : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];
    return best ? parseFloat(best.priceUsd ?? 0) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Trade execution
// ============================================================

function executeTrade(order, action) {
  const scriptName = isSolana(order.chain) ? 'execute-trade-solana.js' : 'execute-trade-evm.js';
  const scriptPath = resolve(__dirname, scriptName);

  const args = [
    '--action',
    action,
    '--chain',
    order.chain,
    '--address',
    order.address,
    '--symbol',
    order.symbol,
    '--amount',
    String(order.amount),
    '--max-slippage',
    order.tier === 'moonshot' ? '5' : '2',
  ];
  if (action === 'buy' && order.tier) {
    args.push('--tier', order.tier);
  }

  try {
    const raw = execSync(`node ${scriptPath} ${args.join(' ')}`, {
      encoding: 'utf-8',
      timeout: 120_000,
      env: process.env,
      cwd: __dirname,
    });
    return JSON.parse(raw);
  } catch (err) {
    // execute-trade-evm.js exits 1 on failure but still outputs JSON
    if (err.stdout) {
      try {
        return JSON.parse(err.stdout);
      } catch {
        // fall through
      }
    }
    return { status: 'failed', error: err.message || 'execute-trade crashed' };
  }
}

// ============================================================
// Receipt writing
// ============================================================

function writeReceipt(db, order, tradeResult, action, positionId) {
  const receiptId = uid('rcpt');
  if (isPaper) {
    db.prepare(
      `INSERT INTO paper_receipts (id, order_id, action, symbol, address, chain, tier, proposed_price, quantity, amount, pnl_percent, pnl_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      order.id,
      action,
      order.symbol,
      order.address,
      order.chain,
      order.tier || null,
      tradeResult.proposedPrice || order.entry_price || 0,
      tradeResult.quantity || null,
      tradeResult.amount || null,
      tradeResult.pnlPercent || null,
      tradeResult.pnlUsd || null,
    );
  } else {
    db.prepare(
      `INSERT INTO receipts (id, order_id, action, symbol, address, chain, amount, quantity, expected_price, executed_price, slippage, status, safe_tx_hash, onchain_tx_hash, error, position_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      order.id,
      action,
      order.symbol,
      order.address,
      order.chain,
      tradeResult.amount || null,
      tradeResult.quantity || null,
      order.entry_price || null,
      tradeResult.executedPrice || tradeResult.price || null,
      tradeResult.slippage || null,
      tradeResult.status || 'executed',
      tradeResult.safeHash || null,
      tradeResult.txHash || tradeResult.txSignature || null,
      tradeResult.error || null,
      positionId || null,
    );
  }
  return receiptId;
}

// ============================================================
// Order status updates
// ============================================================

function markExecuted(db, orderId) {
  db.prepare(
    "UPDATE orders SET status = 'executed', status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(orderId);
}

function markFailed(db, orderId, reason) {
  db.prepare(
    "UPDATE orders SET status = 'failed', status_reason = ?, status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(reason, orderId);
}

// ============================================================
// Alerts
// ============================================================

function sendAlert(type, message) {
  try {
    const scriptPath = resolve(__dirname, 'send-alert.js');
    execFileSync('node', [scriptPath, '--type', type, '--agent', 'executor', '--message', message], {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: __dirname,
    });
  } catch {
    // alerting should never block execution
  }
}

// ============================================================
// Portfolio sync (real mode only — reconcile on-chain balances)
// ============================================================

function syncPortfolio(chain) {
  if (isPaper) return; // paper mode has no on-chain state
  try {
    const scriptName = isSolana(chain) ? 'portfolio-load-solana.js' : 'portfolio-load-evm.js';
    const scriptPath = resolve(__dirname, scriptName);
    execSync(`node ${scriptPath} --chain ${chain} --trigger post_trade`, {
      encoding: 'utf-8',
      timeout: 60_000,
      cwd: __dirname,
    });
  } catch {
    // sync failure should never block order completion
  }
}

// ============================================================
// BUY processing
// ============================================================

async function processBuy(db, order) {
  const result = { ok: false, order_id: order.id, action: 'buy', symbol: order.symbol, chain: order.chain };

  // 1. Validate cash
  const cash = getCash(db, order.chain);
  const amount = parseFloat(order.amount);
  if (cash < amount) {
    const reason = `insufficient_cash: have $${cash.toFixed(2)}, need $${amount}`;
    log(
      'error',
      'process-order',
      `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  // 2. Validate price not stale
  const currentPrice = await fetchCurrentPrice(order.address, order.chain);
  if (currentPrice && order.entry_price) {
    const drift = Math.abs(currentPrice - order.entry_price) / order.entry_price;
    if (drift > STALE_PRICE_THRESHOLD) {
      const reason = `stale_price: proposed $${order.entry_price}, current $${currentPrice} (${(drift * 100).toFixed(1)}% drift)`;
      log(
        'warn',
        'process-order',
        `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
      markFailed(db, order.id, reason);
      sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
      return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
    }
  }

  const execPrice = currentPrice || order.entry_price;

  // 3. Validate we have a usable price
  if (!execPrice || execPrice <= 0) {
    const reason = 'no_price: could not determine execution price';
    log(
      'error',
      'process-order',
      `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  // 4. Execute
  let tradeResult;
  if (isPaper) {
    // Paper: simulate execution at current price
    const quantity = amount / execPrice;
    tradeResult = {
      status: 'executed',
      executedPrice: execPrice,
      quantity,
      amount,
      proposedPrice: order.entry_price,
    };
  } else {
    tradeResult = executeTrade(order, 'buy');
  }

  // 5. Handle result
  if (tradeResult.status === 'failed') {
    const errorMsg = tradeResult.error || 'unknown';
    const reason = `tx_failed: ${errorMsg}`;

    // Transient errors: keep order approved for retry on next heartbeat
    if (isTransientError(errorMsg)) {
      const retries = getRetryCount(db, order.id);
      if (retries < MAX_RETRIES) {
        setRetryCount(db, order.id, retries + 1);
        markRetry(db, order.id, errorMsg, retries + 1);
        log(
          'warn',
          'process-order',
          `BUY transient error: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
        );
        sendAlert('trade_retry', `BUY $${order.symbol}: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES}`);
        return { ...result, status: 'retry', error: reason, retry: retries + 1, max_retries: MAX_RETRIES };
      }
      log(
        'error',
        'process-order',
        `BUY retries exhausted: ${errorMsg} — ${MAX_RETRIES}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      clearRetryCount(db, order.id);
    } else {
      log(
        'error',
        'process-order',
        `BUY tx_failed: ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
    }

    const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed' }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  if (tradeResult.status === 'queued_in_safe' || tradeResult.status === 'queued_in_squads') {
    // Multisig needs more signatures — create draft position (committed but not yet confirmed)
    const positionId = uid('pos');
    const estPrice = tradeResult.executedPrice || execPrice;
    const estQty = tradeResult.quantity || (estPrice > 0 ? amount / estPrice : 0);
    db.prepare(
      `INSERT INTO positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, value_usd, stop_loss, take_profit_levels, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    ).run(
      positionId,
      order.symbol,
      order.address,
      order.chain,
      order.tier || 'moonshot',
      estPrice,
      estPrice,
      estQty,
      amount,
      order.stop_loss,
      order.take_profit_levels || '[]',
    );
    const receiptId = writeReceipt(db, order, tradeResult, 'buy', positionId);
    // Deduct cash — funds are committed to the multisig transaction
    setCash(db, order.chain, cash - amount);
    markExecuted(db, order.id);
    sendAlert('trade_executed', `BUY $${order.symbol} queued (${tradeResult.status}) — draft position created`);
    return { ...result, ok: true, status: tradeResult.status, receipt_id: receiptId, position_id: positionId };
  }

  // Status: executed — write receipt, add position, update cash
  const positionId = uid('pos');
  const finalPrice = tradeResult.executedPrice || tradeResult.price || execPrice;
  const quantity = tradeResult.quantity || (finalPrice > 0 ? amount / finalPrice : 0);
  const posTable = isPaper ? 'paper_positions' : 'positions';

  db.prepare(
    `INSERT INTO ${posTable} (id, symbol, address, chain, tier, entry_price, current_price, quantity, value_usd, stop_loss, take_profit_levels, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`,
  ).run(
    positionId,
    order.symbol,
    order.address,
    order.chain,
    order.tier || 'moonshot',
    finalPrice,
    finalPrice,
    quantity,
    amount,
    order.stop_loss,
    order.take_profit_levels || '[]',
  );

  const receiptId = writeReceipt(db, order, tradeResult, 'buy', positionId);

  // Update cash
  const newCash = cash - amount;
  setCash(db, order.chain, newCash);

  markExecuted(db, order.id);
  clearRetryCount(db, order.id);
  sendAlert('trade_executed', `BUY $${order.symbol} on ${order.chain} — $${amount} at $${finalPrice}`);
  syncPortfolio(order.chain);

  return {
    ...result,
    ok: true,
    status: 'executed',
    receipt_id: receiptId,
    position_id: positionId,
    executed_price: finalPrice,
    quantity,
    cash_after: parseFloat(newCash.toFixed(2)),
  };
}

// ============================================================
// SELL processing
// ============================================================

async function processSell(db, order) {
  const result = { ok: false, order_id: order.id, action: 'sell', symbol: order.symbol, chain: order.chain };

  // 1. Validate position exists
  const position = getPosition(db, order.address, order.chain);
  if (!position) {
    const reason = 'no_position: no matching open position';
    log(
      'error',
      'process-order',
      `SELL validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'sell');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `SELL $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  // 2. Calculate sell quantity
  let sellQty = position.quantity;
  const amountStr = String(order.amount);
  if (amountStr !== 'all' && amountStr.endsWith('%')) {
    const pct = parseFloat(amountStr) / 100;
    sellQty = position.quantity * pct;
  }
  const isPartial = sellQty < position.quantity;

  // 3. Execute
  let tradeResult;
  if (isPaper) {
    const currentPrice = await fetchCurrentPrice(order.address, order.chain);
    const exitPrice = currentPrice || position.current_price || position.entry_price;
    const saleProceeds = exitPrice * sellQty;
    const pnlUsd = (exitPrice - position.entry_price) * sellQty;
    const pnlPercent = position.entry_price > 0 ? ((exitPrice - position.entry_price) / position.entry_price) * 100 : 0;

    tradeResult = {
      status: 'executed',
      executedPrice: exitPrice,
      quantity: sellQty,
      amount: saleProceeds,
      proposedPrice: position.entry_price,
      pnlUsd: parseFloat(pnlUsd.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
    };
  } else {
    // Real mode: pass actual quantity for partial sells
    const sellOrder = { ...order, amount: isPartial ? String(sellQty) : 'all' };
    tradeResult = executeTrade(sellOrder, 'sell');
  }

  // 4. Handle result
  if (tradeResult.status === 'failed') {
    const errorMsg = tradeResult.error || 'unknown';
    const reason = `tx_failed: ${errorMsg}`;

    // Transient errors: keep order approved for retry on next heartbeat
    if (isTransientError(errorMsg)) {
      const retries = getRetryCount(db, order.id);
      if (retries < MAX_RETRIES) {
        setRetryCount(db, order.id, retries + 1);
        markRetry(db, order.id, errorMsg, retries + 1);
        log(
          'warn',
          'process-order',
          `SELL transient error: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
        );
        sendAlert('trade_retry', `SELL $${order.symbol}: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES}`);
        return { ...result, status: 'retry', error: reason, retry: retries + 1, max_retries: MAX_RETRIES };
      }
      log(
        'error',
        'process-order',
        `SELL retries exhausted: ${errorMsg} — ${MAX_RETRIES}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      clearRetryCount(db, order.id);
    } else {
      log(
        'error',
        'process-order',
        `SELL tx_failed: ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
    }

    const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed' }, 'sell');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `SELL $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  if (tradeResult.status === 'queued_in_safe' || tradeResult.status === 'queued_in_squads') {
    // Multisig needs more signatures — mark position as pending_exit
    db.prepare(`UPDATE positions SET status = 'pending_exit', updated_at = datetime('now') WHERE id = ?`).run(
      position.id,
    );
    const receiptId = writeReceipt(db, order, tradeResult, 'sell', position.id);
    markExecuted(db, order.id);
    sendAlert('trade_executed', `SELL $${order.symbol} queued (${tradeResult.status}) — pending confirmation`);
    return { ...result, ok: true, status: tradeResult.status, receipt_id: receiptId, position_id: position.id };
  }

  // Status: executed
  const exitPrice = tradeResult.executedPrice || tradeResult.price || position.current_price;
  const posTable = isPaper ? 'paper_positions' : 'positions';

  if (isPartial) {
    // Partial close: reduce quantity
    const remainQty = position.quantity - sellQty;
    db.prepare(
      `UPDATE ${posTable} SET quantity = ?, status = 'partial_exit', updated_at = datetime('now') WHERE id = ?`,
    ).run(remainQty, position.id);

    // Trailing stop activation after TP hits
    const reason = order.reason || '';
    if (reason === 'tp1_hit') {
      // After TP1: move SL to breakeven (entry price), record TP1 hit
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(1)) tpHit.push(1);
      db.prepare(
        `UPDATE ${posTable} SET stop_loss = ?, tp_levels_hit = ?, max_price_since_entry = COALESCE(max_price_since_entry, ?),
         updated_at = datetime('now') WHERE id = ?`,
      ).run(position.entry_price, JSON.stringify(tpHit), exitPrice, position.id);
    } else if (reason === 'tp2_hit') {
      // After TP2: activate trailing stop
      const trailPct = position.tier === 'moonshot' ? 30 : 20;
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(2)) tpHit.push(2);
      db.prepare(
        `UPDATE ${posTable} SET trailing_stop_pct = ?, trailing_stop_active = 1, tp_levels_hit = ?,
         max_price_since_entry = COALESCE(max_price_since_entry, ?), updated_at = datetime('now') WHERE id = ?`,
      ).run(trailPct, JSON.stringify(tpHit), exitPrice, position.id);
    } else if (reason === 'tp3_hit') {
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(3)) tpHit.push(3);
      db.prepare(`UPDATE ${posTable} SET tp_levels_hit = ?, updated_at = datetime('now') WHERE id = ?`).run(
        JSON.stringify(tpHit),
        position.id,
      );
    }
  } else {
    // Full close
    const pnlUsd = tradeResult.pnlUsd || (exitPrice - position.entry_price) * position.quantity;
    const pnlPercent =
      tradeResult.pnlPercent ||
      (position.entry_price > 0 ? ((exitPrice - position.entry_price) / position.entry_price) * 100 : 0);
    db.prepare(
      `UPDATE ${posTable} SET status = 'closed', exit_price = ?, exit_reason = ?, exit_date = date('now'),
       pnl_usd = ?, pnl_percent = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(exitPrice, order.reason || 'sell', pnlUsd, pnlPercent, position.id);
  }

  const receiptId = writeReceipt(db, order, tradeResult, 'sell', position.id);

  // Update cash after sell
  // - Paper mode: add sale proceeds directly (no on-chain state to sync)
  // - Real mode: do NOT update cash here. syncPortfolio() below refreshes
  //   cash from on-chain balances. If sync fails (silently caught), cash
  //   may be stale until the next scheduled portfolio sync or trade.
  if (isPaper) {
    const saleProceeds = tradeResult.amount || exitPrice * sellQty;
    const cash = getCash(db, order.chain);
    setCash(db, order.chain, cash + saleProceeds);
  }

  markExecuted(db, order.id);
  clearRetryCount(db, order.id);
  sendAlert('trade_executed', `SELL $${order.symbol} on ${order.chain} — ${amountStr} at $${exitPrice}`);
  syncPortfolio(order.chain);

  return {
    ...result,
    ok: true,
    status: 'executed',
    receipt_id: receiptId,
    position_id: position.id,
    executed_price: exitPrice,
    quantity: sellQty,
    pnl_usd: tradeResult.pnlUsd || null,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const orderId = getArg('order-id');
  if (!orderId) {
    console.log(JSON.stringify({ ok: false, error: 'Missing --order-id' }));
    return;
  }

  const db = getDb();

  try {
    const { order, error } = loadOrder(db, orderId);
    if (error) {
      console.log(JSON.stringify({ ok: false, order_id: orderId, error }));
      return;
    }

    // Real mode safety check
    if (!isPaper && !process.env.SAFE_SIGNER_KEY && !isSolana(order.chain)) {
      markFailed(db, orderId, 'no_signer_key');
      console.log(
        JSON.stringify({ ok: false, order_id: orderId, error: 'SAFE_SIGNER_KEY not set and not in paper mode' }),
      );
      return;
    }
    if (!isPaper && !process.env.SQUADS_SIGNER_KEY && isSolana(order.chain)) {
      markFailed(db, orderId, 'no_signer_key');
      console.log(
        JSON.stringify({ ok: false, order_id: orderId, error: 'SQUADS_SIGNER_KEY not set and not in paper mode' }),
      );
      return;
    }

    const result = order.action === 'buy' ? await processBuy(db, order) : await processSell(db, order);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    // Catch-all: mark failed and report
    log('critical', 'process-order', `crash: ${err.message} (order: ${orderId})`);
    try {
      markFailed(db, orderId, `crash: ${err.message}`);
    } catch {
      // DB might be unavailable
    }
    console.log(JSON.stringify({ ok: false, order_id: orderId, error: err.message }));
  } finally {
    close();
  }
}

main();
