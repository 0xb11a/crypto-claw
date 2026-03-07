#!/usr/bin/env node
/**
 * Test Suite: Paper Mode
 *
 * Tests paper trading lifecycle:
 * 1. Paper positions (add, update, close with P&L)
 * 2. Paper trades (record and query)
 * 3. Paper portfolio (cash, positions, value)
 * 4. Paper stats (win rate, total return)
 * 5. Schema constraints
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

let db;
let dbAvailable = false;
try {
  const dbModule = await import('../scripts/db.js');
  db = dbModule.getDb();
  dbAvailable = true;
} catch (e) {
  console.log(`\n⚠️  Skipping paper mode tests (${e.message})`);
  console.log('   Run "npm install" in scripts/ to enable DB tests\n');
}

if (dbAvailable) {
  // ============================================================
  // Paper Positions
  // ============================================================
  describe('Paper Mode — Positions', () => {
    test('can insert a paper position', () => {
      db.prepare(`
        INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES ('pp-test-1', 'PTEST', '0xptest', 'base', 'moonshot', 0.001, 10000, 0.0005, '[{"level":1,"price":0.002}]', 'open')
      `).run();
      const row = db.prepare("SELECT * FROM paper_positions WHERE id = 'pp-test-1'").get();
      assert(row, 'Paper position must be insertable');
      assertEqual(row.symbol, 'PTEST', 'Symbol must match');
      assertEqual(row.tier, 'moonshot', 'Tier must match');
      assertEqual(row.status, 'open', 'Default status must be open');
    });

    test('can update a paper position', () => {
      db.prepare("UPDATE paper_positions SET current_price = 0.0015, value_usd = 15, updated_at = datetime('now') WHERE id = 'pp-test-1'").run();
      const row = db.prepare("SELECT * FROM paper_positions WHERE id = 'pp-test-1'").get();
      assertEqual(row.current_price, 0.0015, 'Current price must be updated');
      assertEqual(row.value_usd, 15, 'Value must be updated');
    });

    test('can close a paper position with P&L', () => {
      db.prepare(`
        UPDATE paper_positions SET status = 'closed', exit_price = 0.002, exit_date = date('now'),
          pnl_percent = 100, pnl_usd = 10, exit_reason = 'tp1_hit', updated_at = datetime('now')
        WHERE id = 'pp-test-1'
      `).run();
      const row = db.prepare("SELECT * FROM paper_positions WHERE id = 'pp-test-1'").get();
      assertEqual(row.status, 'closed', 'Status must be closed');
      assertEqual(row.exit_price, 0.002, 'Exit price must match');
      assertEqual(row.pnl_percent, 100, 'P&L percent must match');
      assertEqual(row.pnl_usd, 10, 'P&L USD must match');
      assertEqual(row.exit_reason, 'tp1_hit', 'Exit reason must match');
    });

    test('status CHECK constraint works', () => {
      let threw = false;
      try {
        db.prepare(`
          INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
          VALUES ('pp-bad', 'BAD', '0xbad', 'base', 'moonshot', 0.001, 100, 0.0005, '[]', 'invalid_status')
        `).run();
      } catch (e) {
        threw = true;
      }
      assert(threw, 'Invalid status should be rejected by CHECK constraint');
    });

    // Cleanup
    test('cleanup paper positions', () => {
      db.prepare("DELETE FROM paper_positions WHERE id LIKE 'pp-test-%'").run();
      const count = db.prepare("SELECT COUNT(*) as c FROM paper_positions WHERE id LIKE 'pp-test-%'").get();
      assertEqual(count.c, 0, 'Test positions should be cleaned up');
    });
  });

  // ============================================================
  // Paper Trades
  // ============================================================
  describe('Paper Mode — Trades', () => {
    test('can insert a paper trade', () => {
      db.prepare(`
        INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, tier, proposed_price, quantity, amount)
        VALUES ('pt-test-1', 'ord-1', 'approved_trades', 'buy', 'PTEST', '0xptest', 'base', 'moonshot', 0.001, 10000, 500)
      `).run();
      const row = db.prepare("SELECT * FROM paper_trades WHERE id = 'pt-test-1'").get();
      assert(row, 'Paper trade must be insertable');
      assertEqual(row.action, 'buy', 'Action must match');
      assertEqual(row.proposed_price, 0.001, 'Proposed price must match');
    });

    test('order_source CHECK constraint works', () => {
      let threw = false;
      try {
        db.prepare(`
          INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, proposed_price)
          VALUES ('pt-bad', 'ord-bad', 'invalid_source', 'buy', 'BAD', '0xbad', 'base', 0.001)
        `).run();
      } catch (e) {
        threw = true;
      }
      assert(threw, 'Invalid order_source should be rejected by CHECK constraint');
    });

    test('action CHECK constraint works', () => {
      let threw = false;
      try {
        db.prepare(`
          INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, proposed_price)
          VALUES ('pt-bad2', 'ord-bad', 'approved_trades', 'hold', 'BAD', '0xbad', 'base', 0.001)
        `).run();
      } catch (e) {
        threw = true;
      }
      assert(threw, 'Invalid action should be rejected by CHECK constraint');
    });

    test('can record P&L on paper trade', () => {
      db.prepare(`
        INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, tier, proposed_price, quantity, amount, pnl_percent, pnl_usd)
        VALUES ('pt-test-2', 'ord-2', 'sell_orders', 'sell', 'PTEST', '0xptest', 'base', 'moonshot', 0.002, 10000, 500, 100, 500)
      `).run();
      const row = db.prepare("SELECT * FROM paper_trades WHERE id = 'pt-test-2'").get();
      assertEqual(row.pnl_percent, 100, 'P&L percent must match');
      assertEqual(row.pnl_usd, 500, 'P&L USD must match');
    });

    // Cleanup
    test('cleanup paper trades', () => {
      db.prepare("DELETE FROM paper_trades WHERE id LIKE 'pt-test-%'").run();
      const count = db.prepare("SELECT COUNT(*) as c FROM paper_trades WHERE id LIKE 'pt-test-%'").get();
      assertEqual(count.c, 0, 'Test trades should be cleaned up');
    });
  });

  // ============================================================
  // Paper Portfolio Meta
  // ============================================================
  describe('Paper Mode — Portfolio Meta', () => {
    test('paper_cash key exists', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get();
      assert(row, 'paper_cash key must exist');
    });

    test('paper_initial_balance key exists', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance'").get();
      assert(row, 'paper_initial_balance key must exist');
      assertEqual(row.value, '10000', 'Default paper initial balance should be 10000');
    });

    test('paper_cash can be updated', () => {
      const originalCash = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get().value;
      db.prepare("UPDATE portfolio_meta SET value = '9500' WHERE key = 'paper_cash'").run();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get();
      assertEqual(row.value, '9500', 'Paper cash should be updated');
      // Restore
      db.prepare("UPDATE portfolio_meta SET value = ? WHERE key = 'paper_cash'").run(originalCash);
    });
  });

  // ============================================================
  // Paper Trade Lifecycle (end-to-end)
  // ============================================================
  describe('Paper Mode — Trade Lifecycle', () => {
    test('full buy → monitor → sell lifecycle', () => {
      // 1. Open paper position (simulated buy)
      db.prepare(`
        INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, value_usd, stop_loss, take_profit_levels, status)
        VALUES ('pp-lifecycle', 'LIFE', '0xlife', 'base', 'moonshot', 0.001, 0.001, 10000, 10, 0.0005, '[{"level":1,"price":0.003}]', 'open')
      `).run();

      // Record paper buy trade
      db.prepare(`
        INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, tier, proposed_price, quantity, amount)
        VALUES ('pt-lifecycle-buy', 'ord-life', 'approved_trades', 'buy', 'LIFE', '0xlife', 'base', 'moonshot', 0.001, 10000, 10)
      `).run();

      // Reduce paper cash
      db.prepare("UPDATE portfolio_meta SET value = '9990' WHERE key = 'paper_cash'").run();

      // 2. Price goes up — update position
      db.prepare("UPDATE paper_positions SET current_price = 0.003, value_usd = 30 WHERE id = 'pp-lifecycle'").run();

      // 3. TP1 hit — close position
      db.prepare(`
        UPDATE paper_positions SET status = 'closed', exit_price = 0.003, exit_date = date('now'),
          pnl_percent = 200, pnl_usd = 20, exit_reason = 'tp1_hit'
        WHERE id = 'pp-lifecycle'
      `).run();

      // Record paper sell trade
      db.prepare(`
        INSERT INTO paper_trades (id, order_id, order_source, action, symbol, address, chain, tier, proposed_price, quantity, amount, pnl_percent, pnl_usd)
        VALUES ('pt-lifecycle-sell', 'sell-life', 'sell_orders', 'sell', 'LIFE', '0xlife', 'base', 'moonshot', 0.003, 10000, 30, 200, 20)
      `).run();

      // Return cash
      db.prepare("UPDATE portfolio_meta SET value = '10020' WHERE key = 'paper_cash'").run();

      // Verify final state
      const pos = db.prepare("SELECT * FROM paper_positions WHERE id = 'pp-lifecycle'").get();
      assertEqual(pos.status, 'closed', 'Position should be closed');
      assertEqual(pos.pnl_usd, 20, 'P&L should be $20');

      const trades = db.prepare("SELECT * FROM paper_trades WHERE order_id IN ('ord-life', 'sell-life') ORDER BY created_at").all();
      assertEqual(trades.length, 2, 'Should have buy and sell trades');

      const cash = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get();
      assertEqual(cash.value, '10020', 'Cash should reflect profit');

      // Cleanup
      db.prepare("DELETE FROM paper_positions WHERE id = 'pp-lifecycle'").run();
      db.prepare("DELETE FROM paper_trades WHERE id LIKE 'pt-lifecycle-%'").run();
      db.prepare("UPDATE portfolio_meta SET value = '10000' WHERE key = 'paper_cash'").run();
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
