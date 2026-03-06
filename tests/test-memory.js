#!/usr/bin/env node
/**
 * Test Suite: Memory System
 *
 * Tests both memory layers:
 * 1. Agent memory (markdown files exist and are readable)
 * 2. Wallet data (SQLite database schema, read/write operations)
 */

import { existsSync, readFileSync } from 'fs';
import { resolve } from 'path';
import { describe, test, assert, assertEqual, assertType, summary } from './test-helpers.js';

const WORKSPACE_DIR = resolve(process.cwd(), 'workspace');

// ============================================================
// Agent Memory (Markdown Files)
// ============================================================
describe('Agent Memory — Markdown Files', () => {
  test('MEMORY.md exists and is readable', () => {
    const path = resolve(WORKSPACE_DIR, 'MEMORY.md');
    assert(existsSync(path), 'MEMORY.md must exist');
    const content = readFileSync(path, 'utf-8');
    assert(content.includes('Long-Term Memory'), 'Should contain memory header');
    assert(content.includes('Market Patterns'), 'Should contain patterns section');
    assert(content.includes('Lessons Learned'), 'Should contain lessons section');
  });

  test('MEMORY.md has scoring calibration table', () => {
    const content = readFileSync(resolve(WORKSPACE_DIR, 'MEMORY.md'), 'utf-8');
    assert(content.includes('Scoring Calibration'), 'Should have scoring calibration section');
  });

  test('MEMORY.md has narrative performance table', () => {
    const content = readFileSync(resolve(WORKSPACE_DIR, 'MEMORY.md'), 'utf-8');
    assert(content.includes('Narrative Performance'), 'Should have narrative performance section');
  });

  test('MEMORY.md does NOT contain wallet-specific data', () => {
    const content = readFileSync(resolve(WORKSPACE_DIR, 'MEMORY.md'), 'utf-8');
    assert(!content.includes('portfolio-state'), 'Should not reference JSON state files');
  });

  test('memory/ directory exists for daily logs', () => {
    const path = resolve(WORKSPACE_DIR, 'memory');
    assert(existsSync(path), 'memory/ directory must exist');
  });

  const requiredWorkspaceFiles = ['USER.md', 'TOOLS.md', 'IDENTITY.md', 'BOOT.md'];
  for (const file of requiredWorkspaceFiles) {
    test(`${file} exists`, () => {
      assert(existsSync(resolve(WORKSPACE_DIR, file)), `${file} must exist`);
    });
  }
});

// ============================================================
// Wallet Data (SQLite via db.js)
// ============================================================

let db;
let dbAvailable = false;
try {
  const dbModule = await import('../scripts/db.js');
  db = dbModule.getDb();
  dbAvailable = true;
} catch (e) {
  console.log(`\n⚠️  Skipping SQLite tests (${e.message})`);
  console.log('   Run "npm install" in scripts/ to enable DB tests\n');
}

if (dbAvailable) {
  describe('Wallet Database — Schema', () => {
    const expectedTables = [
      'positions', 'trades', 'approved_trades', 'sell_orders',
      'trade_receipts', 'sentinel_alerts', 'watchlist',
      'liquidity_snapshots', 'tracked_wallets', 'heartbeat_state',
      'sentinel_log', 'executor_log', 'portfolio_meta', '_migrations',
    ];

    for (const table of expectedTables) {
      test(`table "${table}" exists`, () => {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        assert(row, `Table ${table} must exist`);
      });
    }
  });

  describe('Wallet Database — Portfolio Meta', () => {
    test('cash key exists with default 0', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash'").get();
      assert(row, 'cash key must exist');
      assertEqual(row.value, '0', 'Default cash should be 0');
    });

    test('total_deposited key exists', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'total_deposited'").get();
      assert(row, 'total_deposited key must exist');
    });

    test('safe_id key exists', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'safe_id'").get();
      assert(row, 'safe_id key must exist');
    });
  });

  describe('Wallet Database — Heartbeat State', () => {
    test('research agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'research'").all();
      const checks = rows.map(r => r.check_type);
      for (const check of ['sentinel_alerts', 'token_scan', 'smart_money', 'narrative_check', 'rebalance_review', 'daily_summary', 'watchlist_check']) {
        assert(checks.includes(check), `research must have ${check}`);
      }
    });

    test('sentinel agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'sentinel'").all();
      const checks = rows.map(r => r.check_type);
      for (const check of ['price_check', 'liquidity_check', 'wallet_check']) {
        assert(checks.includes(check), `sentinel must have ${check}`);
      }
    });

    test('executor agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'executor'").all();
      const checks = rows.map(r => r.check_type);
      for (const check of ['process_orders', 'check_pending']) {
        assert(checks.includes(check), `executor must have ${check}`);
      }
    });
  });

  describe('Wallet Database — CRUD Operations', () => {
    test('can insert and query a position', () => {
      db.prepare(`
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES ('test-pos-1', 'TEST', '0xtest', 'base', 'moonshot', 0.001, 10000, 0.0005, '[]', 'open')
      `).run();
      const row = db.prepare("SELECT * FROM positions WHERE id = 'test-pos-1'").get();
      assert(row, 'Position must be insertable and queryable');
      assertEqual(row.symbol, 'TEST', 'Symbol must match');
      assertEqual(row.tier, 'moonshot', 'Tier must match');
      db.prepare("DELETE FROM positions WHERE id = 'test-pos-1'").run();
    });

    test('can insert and mark sell order executed', () => {
      db.prepare(`
        INSERT INTO sell_orders (id, symbol, address, chain, amount, reason, urgency)
        VALUES ('test-sell-1', 'TEST', '0xtest', 'base', 'all', 'stop_loss', 'immediate')
      `).run();
      const row = db.prepare("SELECT * FROM sell_orders WHERE id = 'test-sell-1'").get();
      assertEqual(row.executed, 0, 'Should default to not executed');
      db.prepare("UPDATE sell_orders SET executed = 1 WHERE id = 'test-sell-1'").run();
      const updated = db.prepare("SELECT executed FROM sell_orders WHERE id = 'test-sell-1'").get();
      assertEqual(updated.executed, 1, 'Should be marked executed');
      db.prepare("DELETE FROM sell_orders WHERE id = 'test-sell-1'").run();
    });

    test('can insert trade receipt', () => {
      db.prepare(`
        INSERT INTO trade_receipts (id, order_id, order_source, action, symbol, address, chain, status)
        VALUES ('test-rcpt-1', 'ord-1', 'sell_orders', 'sell', 'TEST', '0xtest', 'base', 'executed')
      `).run();
      const row = db.prepare("SELECT * FROM trade_receipts WHERE id = 'test-rcpt-1'").get();
      assert(row, 'Receipt must be insertable');
      assertEqual(row.status, 'executed', 'Status must match');
      db.prepare("DELETE FROM trade_receipts WHERE id = 'test-rcpt-1'").run();
    });

    test('can insert and process alert', () => {
      db.prepare(`
        INSERT INTO sentinel_alerts (id, symbol, chain, alert_type, severity)
        VALUES ('test-alert-1', 'TEST', 'base', 'stop_loss', 'critical')
      `).run();
      const row = db.prepare("SELECT processed FROM sentinel_alerts WHERE id = 'test-alert-1'").get();
      assertEqual(row.processed, 0, 'Should default to unprocessed');
      db.prepare("DELETE FROM sentinel_alerts WHERE id = 'test-alert-1'").run();
    });

    test('portfolio_meta upsert works', () => {
      db.prepare("INSERT INTO portfolio_meta (key, value) VALUES ('_test', '42') ON CONFLICT(key) DO UPDATE SET value = '42'").run();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = '_test'").get();
      assertEqual(row.value, '42', 'Upsert must work');
      db.prepare("DELETE FROM portfolio_meta WHERE key = '_test'").run();
    });

    test('tier CHECK constraint works', () => {
      let threw = false;
      try {
        db.prepare(`
          INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
          VALUES ('test-bad', 'BAD', '0xbad', 'base', 'invalid_tier', 0.001, 100, 0.0005, '[]', 'open')
        `).run();
      } catch (e) {
        threw = true;
      }
      assert(threw, 'Invalid tier should be rejected by CHECK constraint');
    });
  });

  // Close DB
  const { close } = await import('../scripts/db.js');
  close();
}

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
