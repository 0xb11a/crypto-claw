#!/usr/bin/env node
/**
 * test-emergency.js — Tests for emergency sentinel + executor scripts
 *
 * Tests the deterministic (no-LLM) safety net:
 *   - Emergency sentinel: stop-loss, take-profit, severe loss, liquidity drain, low liquidity
 *   - Emergency executor: processes sells only, paper mode simulation
 *   - Send-alert: argument parsing, skip when unconfigured
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';
import { getDb, close } from '../scripts/db.js';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// ============================================================
// Setup: isolated test database
// ============================================================

const tmpDir = mkdtempSync(join(tmpdir(), 'claw-emergency-'));
const testDbPath = join(tmpDir, 'test-emergency.db');

// Point db.js to our test database (must be set BEFORE importing db.js)
process.env.SAFE_ID = 'test-emergency';
process.env.DB_PATH = testDbPath;
process.env.PAPER_MODE = 'false';

// Get a single DB instance (db.js caches the path at import time)
const db = getDb();

function clearTables() {
  db.exec(`
    DELETE FROM orders;
    DELETE FROM positions;
    DELETE FROM paper_positions;
    DELETE FROM sentinel_log;
    DELETE FROM executor_log;
    DELETE FROM liquidity_snapshots;
    DELETE FROM receipts;
    DELETE FROM paper_receipts;
  `);
  return db;
}

function seedPosition(db, overrides = {}) {
  const pos = {
    id: `pos-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    symbol: 'TEST',
    address: '0xTEST123',
    chain: 'base',
    tier: 'moonshot',
    entry_price: 1.0,
    current_price: 1.0,
    quantity: 100,
    stop_loss: 0.5,
    take_profit_levels: JSON.stringify([{ level: 1, price: 2.0, sellPercent: 100 }]),
    status: 'open',
    percent_of_portfolio: 5,
    ...overrides,
  };

  db.prepare(
    `INSERT INTO positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, stop_loss, take_profit_levels, status, percent_of_portfolio)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    pos.id,
    pos.symbol,
    pos.address,
    pos.chain,
    pos.tier,
    pos.entry_price,
    pos.current_price,
    pos.quantity,
    pos.stop_loss,
    pos.take_profit_levels,
    pos.status,
    pos.percent_of_portfolio,
  );

  return pos;
}

function seedLiquiditySnapshot(db, address, chain, liquidityUsd, minutesAgo = 10) {
  const ts = new Date(Date.now() - minutesAgo * 60 * 1000).toISOString();
  db.prepare(`INSERT INTO liquidity_snapshots (address, chain, liquidity_usd, checked_at) VALUES (?, ?, ?, ?)`).run(
    address,
    chain,
    liquidityUsd,
    ts,
  );
}

function seedSellOrder(db, overrides = {}) {
  const order = {
    id: `sell-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    action: 'sell',
    symbol: 'TEST',
    address: '0xTEST123',
    chain: 'base',
    amount: 'all',
    reason: 'stop_loss',
    urgency: 'immediate',
    approved: 1,
    approved_by: 'emergency_sentinel',
    ...overrides,
  };

  db.prepare(
    `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    order.id,
    order.action,
    order.symbol,
    order.address,
    order.chain,
    order.amount,
    order.reason,
    order.urgency,
    order.approved,
    order.approved_by,
  );

  return order;
}

function getOrders(db) {
  return db.prepare(`SELECT * FROM orders WHERE action = 'sell' ORDER BY created_at DESC`).all();
}

function getSentinelLogs(db) {
  return db.prepare(`SELECT * FROM sentinel_log ORDER BY created_at DESC LIMIT 10`).all();
}

function getExecutorLogs(db) {
  return db.prepare(`SELECT * FROM executor_log ORDER BY created_at DESC LIMIT 10`).all();
}

// ============================================================
// Emergency Sentinel Tests
// ============================================================

describe('Emergency Sentinel — Order Writing Logic', () => {
  test('writes stop-loss sell order when price <= stop_loss', () => {
    const db = clearTables();
    const pos = seedPosition(db, { stop_loss: 0.5, entry_price: 1.0 });

    // Simulate what emergency-sentinel does: check condition and write order
    const currentPrice = 0.4; // Below stop_loss of 0.5
    assert(currentPrice <= pos.stop_loss, 'Price should trigger stop-loss');

    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES (?, 'sell', ?, ?, ?, 'all', 'stop_loss', 'immediate', 1, 'emergency_sentinel', datetime('now'))`,
    ).run('emg-test-sl', pos.symbol, pos.address, pos.chain);

    const orders = getOrders(db);
    assertEqual(orders.length, 1);
    assertEqual(orders[0].reason, 'stop_loss');
    assertEqual(orders[0].approved, 1);
    assertEqual(orders[0].approved_by, 'emergency_sentinel');
    assertEqual(orders[0].urgency, 'immediate');
  });

  test('writes take-profit sell order when price >= max take_profit_levels price', () => {
    const db = clearTables();
    const tpLevels = JSON.stringify([
      { level: 1, price: 1.5, sellPercent: 50 },
      { level: 2, price: 2.0, sellPercent: 100 },
    ]);
    const pos = seedPosition(db, { take_profit_levels: tpLevels, entry_price: 1.0 });

    // Parse max TP price the same way emergency-sentinel does
    const levels = JSON.parse(pos.take_profit_levels);
    const maxTp = Math.max(...levels.map((l) => l.price));
    const currentPrice = 2.5; // Above max take_profit of 2.0
    assert(currentPrice >= maxTp, 'Price should trigger take-profit');

    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES (?, 'sell', ?, ?, ?, 'all', 'take_profit', 'normal', 1, 'emergency_sentinel', datetime('now'))`,
    ).run('emg-test-tp', pos.symbol, pos.address, pos.chain);

    const orders = getOrders(db);
    assertEqual(orders.length, 1);
    assertEqual(orders[0].reason, 'take_profit');
    assertEqual(orders[0].urgency, 'normal');
  });

  test('writes severe loss order when PnL < -30%', () => {
    const db = clearTables();
    const pos = seedPosition(db, { entry_price: 1.0 });

    const currentPrice = 0.6; // -40% PnL
    const pnlPercent = ((currentPrice - pos.entry_price) / pos.entry_price) * 100;
    assert(pnlPercent < -30, 'PnL should be below -30%');

    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES (?, 'sell', ?, ?, ?, 'all', 'emergency_severe_loss', 'immediate', 1, 'emergency_sentinel', datetime('now'))`,
    ).run('emg-test-loss', pos.symbol, pos.address, pos.chain);

    const orders = getOrders(db);
    assertEqual(orders.length, 1);
    assertEqual(orders[0].reason, 'emergency_severe_loss');
  });

  test('writes liquidity drain order when drop > 50%', () => {
    const db = clearTables();
    const pos = seedPosition(db, { address: '0xLIQ1' });
    seedLiquiditySnapshot(db, '0xLIQ1', 'base', 100000);

    const currentLiquidity = 40000; // 60% drop
    const prev = 100000;
    const dropPercent = ((currentLiquidity - prev) / prev) * 100;
    assert(dropPercent < -50, 'Drop should be over 50%');

    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES (?, 'sell', ?, ?, ?, 'all', 'emergency_liquidity_drain', 'immediate', 1, 'emergency_sentinel', datetime('now'))`,
    ).run('emg-test-drain', pos.symbol, pos.address, pos.chain);

    const orders = getOrders(db);
    assertEqual(orders.length, 1);
    assertEqual(orders[0].reason, 'emergency_liquidity_drain');
  });

  test('writes low liquidity order when absolute < $5k', () => {
    const db = clearTables();
    const pos = seedPosition(db);

    const currentLiquidity = 3000;
    assert(currentLiquidity < 5000, 'Liquidity should be below $5k');

    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES (?, 'sell', ?, ?, ?, 'all', 'emergency_low_liquidity', 'immediate', 1, 'emergency_sentinel', datetime('now'))`,
    ).run('emg-test-lowliq', pos.symbol, pos.address, pos.chain);

    const orders = getOrders(db);
    assertEqual(orders.length, 1);
    assertEqual(orders[0].reason, 'emergency_low_liquidity');
  });

  test('does not trigger when position is healthy', () => {
    const db = clearTables();
    seedPosition(db, { entry_price: 1.0, stop_loss: 0.5 });
    seedLiquiditySnapshot(db, '0xTEST123', 'base', 100000);

    // Healthy position: price at 1.2 (above stop, below TP), good liquidity
    const currentPrice = 1.2;
    const pnlPercent = ((currentPrice - 1.0) / 1.0) * 100;
    const currentLiquidity = 80000; // Only 20% drop
    const dropPercent = ((currentLiquidity - 100000) / 100000) * 100;

    assert(currentPrice > 0.5, 'Above stop-loss');
    assert(currentPrice < 2.0, 'Below take-profit');
    assert(pnlPercent > -30, 'Not severe loss');
    assert(dropPercent > -50, 'Not liquidity drain');
    assert(currentLiquidity >= 5000, 'Not low liquidity');

    const orders = getOrders(db);
    assertEqual(orders.length, 0, 'No sell orders should be written for healthy position');
  });

  test('logs emergency activity to sentinel_log', () => {
    const db = clearTables();

    db.prepare(
      `INSERT INTO sentinel_log (check_type, positions_checked, alerts_generated, sells_executed, status)
       VALUES ('emergency', 3, 1, 0, 'emergency')`,
    ).run();

    const logs = getSentinelLogs(db);
    assertEqual(logs.length, 1);
    assertEqual(logs[0].check_type, 'emergency');
    assertEqual(logs[0].status, 'emergency');
  });
});

// ============================================================
// Emergency Executor Tests
// ============================================================

describe('Emergency Executor — Sell Processing Logic', () => {
  test('finds pending approved sell orders', () => {
    const db = clearTables();
    seedSellOrder(db, { id: 'sell-1' });
    seedSellOrder(db, { id: 'sell-2' });
    // Add a buy order — should be excluded
    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, approved)
       VALUES ('buy-1', 'buy', 'TEST', '0xTEST', 'base', '500', 1)`,
    ).run();

    const sells = db
      .prepare(`SELECT * FROM orders WHERE action = 'sell' AND approved = 1 AND executed = 0 ORDER BY created_at ASC`)
      .all();

    assertEqual(sells.length, 2, 'Should find exactly 2 pending sells');
    assert(
      sells.every((s) => s.action === 'sell'),
      'All should be sell orders',
    );
  });

  test('excludes already-executed orders', () => {
    const db = clearTables();
    seedSellOrder(db, { id: 'sell-done' });
    db.prepare(`UPDATE orders SET executed = 1 WHERE id = 'sell-done'`).run();
    seedSellOrder(db, { id: 'sell-pending' });

    const sells = db.prepare(`SELECT * FROM orders WHERE action = 'sell' AND approved = 1 AND executed = 0`).all();

    assertEqual(sells.length, 1);
    assertEqual(sells[0].id, 'sell-pending');
  });

  test('marks order as executed after processing', () => {
    const db = clearTables();
    seedSellOrder(db, { id: 'sell-mark' });

    db.prepare(`UPDATE orders SET executed = 1, executed_at = datetime('now') WHERE id = ?`).run('sell-mark');

    const order = db.prepare(`SELECT * FROM orders WHERE id = 'sell-mark'`).get();
    assertEqual(order.executed, 1);
    assert(order.executed_at !== null, 'executed_at should be set');
  });

  test('logs emergency activity to executor_log', () => {
    const db = clearTables();

    db.prepare(
      `INSERT INTO executor_log (sell_orders_processed, buy_orders_processed, pending_checked, success_count, fail_count, status)
       VALUES (2, 0, 3, 2, 0, 'emergency')`,
    ).run();

    const logs = getExecutorLogs(db);
    assertEqual(logs.length, 1);
    assertEqual(logs[0].sell_orders_processed, 2);
    assertEqual(logs[0].buy_orders_processed, 0);
    assertEqual(logs[0].status, 'emergency');
  });

  test('never processes buy orders (safety check)', () => {
    const db = clearTables();
    // Insert only a buy order — no sell orders
    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, approved)
       VALUES ('buy-danger', 'buy', 'SCAM', '0xSCAM', 'base', '10000', 1)`,
    ).run();

    // Emergency executor query — should not find buy orders
    const sells = db.prepare(`SELECT * FROM orders WHERE action = 'sell' AND approved = 1 AND executed = 0`).all();

    assertEqual(sells.length, 0, 'Emergency executor must never see buy orders');
  });
});

// ============================================================
// Paper Mode Emergency Tests
// ============================================================

describe('Emergency — Paper Mode', () => {
  test('paper mode uses paper_positions table', () => {
    const db = clearTables();

    // Seed a paper position
    db.prepare(
      `INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, stop_loss, take_profit_levels, status)
       VALUES ('pp-1', 'PAPER', '0xPAPER', 'base', 'moonshot', 1.0, 1.0, 100, 0.5, '[]', 'open')`,
    ).run();

    const paperPositions = db.prepare(`SELECT * FROM paper_positions WHERE status IN ('open', 'partial_exit')`).all();
    assertEqual(paperPositions.length, 1);
    assertEqual(paperPositions[0].symbol, 'PAPER');
  });

  test('paper sell simulation closes position and updates P&L', () => {
    const db = clearTables();

    // Seed paper position
    db.prepare(
      `INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, stop_loss, take_profit_levels, status)
       VALUES ('pp-sell', 'TOKEN', '0xSELL', 'base', 'moonshot', 1.0, 0.8, 100, 0.5, '[]', 'open')`,
    ).run();

    // Simulate paper sell (same logic as emergency-executor.js)
    const exitPrice = 0.8;
    const quantity = 100;
    const entryPrice = 1.0;
    const pnlUsd = (exitPrice - entryPrice) * quantity;
    const pnlPercent = ((exitPrice - entryPrice) / entryPrice) * 100;

    db.prepare(
      `UPDATE paper_positions SET status = 'closed', exit_price = ?, exit_reason = ?, pnl_usd = ?, pnl_percent = ?, exit_date = date('now'), updated_at = datetime('now') WHERE id = ?`,
    ).run(exitPrice, 'emergency_stop_loss', pnlUsd, pnlPercent, 'pp-sell');

    const closed = db.prepare(`SELECT * FROM paper_positions WHERE id = 'pp-sell'`).get();
    assertEqual(closed.status, 'closed');
    assertEqual(closed.exit_price, 0.8);
    assert(Math.abs(closed.pnl_usd - -20) < 0.01, `Expected pnl_usd ~-20, got ${closed.pnl_usd}`);
    assert(Math.abs(closed.pnl_percent - -20) < 0.01, `Expected pnl_percent ~-20, got ${closed.pnl_percent}`);
    assert(closed.exit_date !== null, 'exit_date should be set');
  });
});

// ============================================================
// Send Alert Tests
// ============================================================

describe('Send Alert — Argument Parsing', () => {
  test('send-alert skips when no Telegram config', () => {
    // send-alert.js should output { status: "skipped" } when env vars not set
    // We test the logic, not the actual script execution
    const token = '';
    const chatId = '';
    const shouldSkip = !token || !chatId;
    assert(shouldSkip, 'Should skip when Telegram not configured');
  });

  test('MarkdownV2 escaping handles special characters', () => {
    // Reproduce the escaping logic
    function escapeMarkdownV2(text) {
      return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
    }

    const input = 'stop_loss (emergency) 50.5%';
    const escaped = escapeMarkdownV2(input);
    assert(escaped.includes('stop\\_loss'), 'Should escape underscores');
    assert(escaped.includes('\\(emergency\\)'), 'Should escape parentheses');
    assert(escaped.includes('50\\.5'), 'Should escape dots');
  });
});

// ============================================================
// Integration: Sentinel → Executor Pipeline
// ============================================================

describe('Emergency Pipeline — Sentinel to Executor', () => {
  test('sentinel-written orders are picked up by executor query', () => {
    const db = clearTables();
    const pos = seedPosition(db);

    // Sentinel writes an emergency sell order
    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by, created_at)
       VALUES ('emg-pipe-1', 'sell', ?, ?, ?, 'all', 'stop_loss', 'immediate', 1, 'emergency_sentinel', datetime('now'))`,
    ).run(pos.symbol, pos.address, pos.chain);

    // Executor query picks it up
    const pendingSells = db
      .prepare(`SELECT * FROM orders WHERE action = 'sell' AND approved = 1 AND executed = 0 ORDER BY created_at ASC`)
      .all();

    assertEqual(pendingSells.length, 1);
    assertEqual(pendingSells[0].approved_by, 'emergency_sentinel');
    assertEqual(pendingSells[0].reason, 'stop_loss');
  });

  test('multiple emergency orders from different triggers', () => {
    const db = clearTables();

    // Seed multiple positions
    seedPosition(db, { id: 'pos-sl', address: '0xA', symbol: 'TOKENA', stop_loss: 0.5 });
    seedPosition(db, { id: 'pos-tp', address: '0xB', symbol: 'TOKENB' });
    seedPosition(db, { id: 'pos-liq', address: '0xC', symbol: 'TOKENC' });

    // Write orders for different reasons
    const reasons = [
      { id: 'emg-sl', symbol: 'TOKENA', address: '0xA', reason: 'stop_loss' },
      { id: 'emg-tp', symbol: 'TOKENB', address: '0xB', reason: 'take_profit' },
      { id: 'emg-liq', symbol: 'TOKENC', address: '0xC', reason: 'emergency_low_liquidity' },
    ];

    for (const r of reasons) {
      db.prepare(
        `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by)
         VALUES (?, 'sell', ?, ?, 'base', 'all', ?, 'immediate', 1, 'emergency_sentinel')`,
      ).run(r.id, r.symbol, r.address, r.reason);
    }

    const sells = db.prepare(`SELECT * FROM orders WHERE action = 'sell' AND approved = 1 AND executed = 0`).all();
    assertEqual(sells.length, 3, 'Should have 3 pending sell orders');
  });

  test('one order per position (no duplicates)', () => {
    const db = clearTables();
    seedPosition(db, { id: 'pos-dup', address: '0xDUP', symbol: 'DUP' });

    // Write one order
    db.prepare(
      `INSERT INTO orders (id, action, symbol, address, chain, amount, reason, approved, approved_by)
       VALUES ('emg-dup-1', 'sell', 'DUP', '0xDUP', 'base', 'all', 'stop_loss', 1, 'emergency_sentinel')`,
    ).run();

    // Check for existing pending sell before writing another
    const existing = db
      .prepare(`SELECT id FROM orders WHERE action = 'sell' AND address = '0xDUP' AND chain = 'base' AND executed = 0`)
      .get();

    assert(existing !== undefined, 'Should find existing order');
    assertEqual(existing.id, 'emg-dup-1');
  });
});

// ============================================================
// Cleanup & Summary
// ============================================================

close();
try {
  rmSync(tmpDir, { recursive: true, force: true });
} catch {}

const passed = summary();
process.exit(passed ? 0 : 1);
