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
import { describe, test, assert, assertEqual, assertType as _assertType, summary } from './test-helpers.js';

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
      'positions',
      'trades',
      'orders',
      'receipts',
      'sentinel_alerts',
      'watchlist',
      'liquidity_snapshots',
      'tracked_wallets',
      'heartbeat_state',
      'sentinel_log',
      'executor_log',
      'portfolio_meta',
      '_migrations',
      'paper_receipts',
      'paper_positions',
      'analysis_cache',
      'contract_snapshots',
    ];

    for (const table of expectedTables) {
      test(`table "${table}" exists`, () => {
        const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table);
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

    test('paper_cash key exists with default 10000', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash'").get();
      assert(row, 'paper_cash key must exist');
      assertEqual(row.value, '10000', 'Default paper cash should be 10000');
    });

    test('paper_initial_balance key exists', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance'").get();
      assert(row, 'paper_initial_balance key must exist');
    });

    // Per-chain keys (migration 009)
    test('cash_base key exists after migration', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash_base'").get();
      assert(row, 'cash_base key must exist after migration 009');
    });

    test('cash_solana key exists after migration', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash_solana'").get();
      assert(row, 'cash_solana key must exist after migration 009');
    });

    test('paper_cash_base key exists after migration', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash_base'").get();
      assert(row, 'paper_cash_base key must exist');
    });

    test('paper_cash_solana key exists after migration', () => {
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_cash_solana'").get();
      assert(row, 'paper_cash_solana key must exist');
    });
  });

  describe('Wallet Database — Heartbeat State', () => {
    test('research agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'research'").all();
      const checks = rows.map((r) => r.check_type);
      for (const check of [
        'sentinel_alerts',
        'token_scan',
        'smart_money',
        'narrative_check',
        'rebalance_review',
        'daily_summary',
        'watchlist_check',
      ]) {
        assert(checks.includes(check), `research must have ${check}`);
      }
    });

    test('sentinel agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'sentinel'").all();
      const checks = rows.map((r) => r.check_type);
      for (const check of ['price_check', 'liquidity_check', 'wallet_check', 'contract_check']) {
        assert(checks.includes(check), `sentinel must have ${check}`);
      }
    });

    test('executor agent has all check types', () => {
      const rows = db.prepare("SELECT check_type FROM heartbeat_state WHERE agent = 'executor'").all();
      const checks = rows.map((r) => r.check_type);
      for (const check of ['process_orders']) {
        assert(checks.includes(check), `executor must have ${check}`);
      }
    });
  });

  describe('Wallet Database — CRUD Operations', () => {
    test('can insert and query a position', () => {
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES ('test-pos-1', 'TEST', '0xtest', 'base', 'moonshot', 0.001, 10000, 0.0005, '[]', 'open')
      `,
      ).run();
      const row = db.prepare("SELECT * FROM positions WHERE id = 'test-pos-1'").get();
      assert(row, 'Position must be insertable and queryable');
      assertEqual(row.symbol, 'TEST', 'Symbol must match');
      assertEqual(row.tier, 'moonshot', 'Tier must match');
      db.prepare("DELETE FROM positions WHERE id = 'test-pos-1'").run();
    });

    test('can insert and mark sell order executed', () => {
      db.prepare(
        `
        INSERT INTO orders (id, action, symbol, address, chain, amount, reason, urgency, approved, approved_by)
        VALUES ('test-sell-1', 'sell', 'TEST', '0xtest', 'base', 'all', 'stop_loss', 'immediate', 1, 'sentinel')
      `,
      ).run();
      const row = db.prepare("SELECT * FROM orders WHERE id = 'test-sell-1'").get();
      assertEqual(row.executed, 0, 'Should default to not executed');
      db.prepare("UPDATE orders SET executed = 1 WHERE id = 'test-sell-1'").run();
      const updated = db.prepare("SELECT executed FROM orders WHERE id = 'test-sell-1'").get();
      assertEqual(updated.executed, 1, 'Should be marked executed');
      db.prepare("DELETE FROM orders WHERE id = 'test-sell-1'").run();
    });

    test('can insert trade receipt', () => {
      db.prepare(
        `
        INSERT INTO receipts (id, order_id, action, symbol, address, chain, status)
        VALUES ('test-rcpt-1', 'ord-1', 'sell', 'TEST', '0xtest', 'base', 'executed')
      `,
      ).run();
      const row = db.prepare("SELECT * FROM receipts WHERE id = 'test-rcpt-1'").get();
      assert(row, 'Receipt must be insertable');
      assertEqual(row.status, 'executed', 'Status must match');
      db.prepare("DELETE FROM receipts WHERE id = 'test-rcpt-1'").run();
    });

    test('can insert and process alert', () => {
      db.prepare(
        `
        INSERT INTO sentinel_alerts (id, symbol, chain, alert_type, severity)
        VALUES ('test-alert-1', 'TEST', 'base', 'stop_loss', 'critical')
      `,
      ).run();
      const row = db.prepare("SELECT processed FROM sentinel_alerts WHERE id = 'test-alert-1'").get();
      assertEqual(row.processed, 0, 'Should default to unprocessed');
      db.prepare("DELETE FROM sentinel_alerts WHERE id = 'test-alert-1'").run();
    });

    test('portfolio_meta upsert works', () => {
      db.prepare(
        "INSERT INTO portfolio_meta (key, value) VALUES ('_test', '42') ON CONFLICT(key) DO UPDATE SET value = '42'",
      ).run();
      const row = db.prepare("SELECT value FROM portfolio_meta WHERE key = '_test'").get();
      assertEqual(row.value, '42', 'Upsert must work');
      db.prepare("DELETE FROM portfolio_meta WHERE key = '_test'").run();
    });

    test('get-positions --symbol filters correctly', () => {
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES ('test-sym-1', 'ALPHA', '0xalpha', 'base', 'moonshot', 0.01, 1000, 0.005, '[]', 'open')
      `,
      ).run();
      db.prepare(
        `
        INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
        VALUES ('test-sym-2', 'BETA', '0xbeta', 'base', 'conviction', 1.5, 200, 1.0, '[]', 'open')
      `,
      ).run();
      // Filter by symbol
      const alpha = db.prepare("SELECT * FROM positions WHERE status = 'open' AND symbol = ?").all('ALPHA');
      assertEqual(alpha.length, 1, 'Should return exactly 1 ALPHA position');
      assertEqual(alpha[0].id, 'test-sym-1', 'Should be the ALPHA position');
      // All status + symbol
      const beta = db.prepare('SELECT * FROM positions WHERE symbol = ?').all('BETA');
      assertEqual(beta.length, 1, 'Should return exactly 1 BETA position');
      // Non-existent symbol
      const none = db.prepare("SELECT * FROM positions WHERE status = 'open' AND symbol = ?").all('NONEXISTENT');
      assertEqual(none.length, 0, 'Non-existent symbol should return empty');
      db.prepare("DELETE FROM positions WHERE id IN ('test-sym-1', 'test-sym-2')").run();
    });

    test('paper_positions --symbol filters correctly', () => {
      db.prepare(
        `
        INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status, value_usd)
        VALUES ('test-pp-sym-1', 'ALPHA', '0xalpha', 'base', 'moonshot', 0.01, 1000, 0.005, '[]', 'open', 10)
      `,
      ).run();
      db.prepare(
        `
        INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status, value_usd)
        VALUES ('test-pp-sym-2', 'BETA', '0xbeta', 'base', 'conviction', 1.5, 200, 1.0, '[]', 'open', 300)
      `,
      ).run();
      const alpha = db.prepare("SELECT * FROM paper_positions WHERE status = 'open' AND symbol = ?").all('ALPHA');
      assertEqual(alpha.length, 1, 'Should return exactly 1 ALPHA paper position');
      assertEqual(alpha[0].id, 'test-pp-sym-1', 'Should be the ALPHA paper position');
      db.prepare("DELETE FROM paper_positions WHERE id IN ('test-pp-sym-1', 'test-pp-sym-2')").run();
    });

    test('tier CHECK constraint works', () => {
      let threw = false;
      try {
        db.prepare(
          `
          INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, stop_loss, take_profit_levels, status)
          VALUES ('test-bad', 'BAD', '0xbad', 'base', 'invalid_tier', 0.001, 100, 0.0005, '[]', 'open')
        `,
        ).run();
      } catch {
        threw = true;
      }
      assert(threw, 'Invalid tier should be rejected by CHECK constraint');
    });
  });

  describe('Wallet Database — Position Exit Columns', () => {
    test('positions table has exit accounting columns', () => {
      const cols = db
        .prepare('PRAGMA table_info(positions)')
        .all()
        .map((c) => c.name);
      for (const col of ['exit_price', 'exit_date', 'pnl_percent', 'pnl_usd', 'exit_reason']) {
        assert(cols.includes(col), `positions must have column '${col}'`);
      }
    });
  });

  describe('Wallet Database — Wallet Scoring Pipeline', () => {
    test('tracked_wallets has scoring columns', () => {
      const cols = db
        .prepare('PRAGMA table_info(tracked_wallets)')
        .all()
        .map((c) => c.name);
      for (const col of [
        'status',
        'score',
        'score_breakdown',
        'source_token',
        'scored_at',
        'score_error',
        'retry_count',
        'source',
      ]) {
        assert(cols.includes(col), `tracked_wallets must have column '${col}'`);
      }
    });

    test('source column defaults to agent', () => {
      db.prepare(
        `
        INSERT OR IGNORE INTO tracked_wallets (address, chain, label, status)
        VALUES ('0xtest_source_default', 'base', 'test default source', 'proposed')
      `,
      ).run();
      const row = db.prepare("SELECT source FROM tracked_wallets WHERE address = '0xtest_source_default'").get();
      assertEqual(row.source, 'agent', 'Default source must be agent');
      db.prepare("DELETE FROM tracked_wallets WHERE address = '0xtest_source_default'").run();
    });

    test('source column accepts leaderboard, token_traders, holder_extraction', () => {
      for (const source of ['leaderboard', 'token_traders', 'holder_extraction']) {
        db.prepare(
          `
          INSERT OR REPLACE INTO tracked_wallets (address, chain, source, status)
          VALUES ('0xtest_source_${source}', 'base', ?, 'proposed')
        `,
        ).run(source);
        const row = db.prepare(`SELECT source FROM tracked_wallets WHERE address = '0xtest_source_${source}'`).get();
        assertEqual(row.source, source, `Source '${source}' must be accepted`);
        db.prepare(`DELETE FROM tracked_wallets WHERE address = '0xtest_source_${source}'`).run();
      }
    });

    test('propose wallet → appears in unscored query', () => {
      db.prepare(
        `
        INSERT OR IGNORE INTO tracked_wallets (address, chain, label, source_token, status)
        VALUES ('0xtest_propose', 'base', 'Test proposed wallet', '0xtokensrc', 'proposed')
      `,
      ).run();
      const unscored = db
        .prepare(
          `
        SELECT * FROM tracked_wallets
        WHERE status = 'proposed' OR (status = 'failed' AND retry_count < 3)
      `,
        )
        .all();
      const found = unscored.find((w) => w.address === '0xtest_propose');
      assert(found, 'Proposed wallet must appear in unscored query');
      assertEqual(found.status, 'proposed', 'Status must be proposed');
      assertEqual(found.source_token, '0xtokensrc', 'source_token must be set');
    });

    test('update wallet score → no longer unscored', () => {
      db.prepare(
        `
        UPDATE tracked_wallets
        SET status = 'scored', score = 78, type = 'smart_money',
            score_breakdown = '{"profitability":85}', scored_at = datetime('now')
        WHERE address = '0xtest_propose' AND chain = 'base'
      `,
      ).run();
      const unscored = db
        .prepare(
          `
        SELECT * FROM tracked_wallets
        WHERE (status = 'proposed' OR (status = 'failed' AND retry_count < 3))
          AND address = '0xtest_propose'
      `,
        )
        .all();
      assertEqual(unscored.length, 0, 'Scored wallet must not appear in unscored query');
      const scored = db.prepare("SELECT * FROM tracked_wallets WHERE address = '0xtest_propose'").get();
      assertEqual(scored.score, 78, 'Score must be 78');
      assertEqual(scored.type, 'smart_money', 'Type must be smart_money');
    });

    test('status CHECK rejects invalid values', () => {
      let threw = false;
      try {
        db.prepare(
          `
          INSERT INTO tracked_wallets (address, chain, status)
          VALUES ('0xtest_bad_status', 'base', 'invalid_status')
        `,
        ).run();
      } catch {
        threw = true;
      }
      assert(threw, 'Invalid status should be rejected by CHECK constraint');
    });

    test('type allows trader and retail', () => {
      for (const type of ['trader', 'retail']) {
        db.prepare(
          `
          INSERT OR REPLACE INTO tracked_wallets (address, chain, type, status)
          VALUES ('0xtest_type_${type}', 'base', ?, 'scored')
        `,
        ).run(type);
        const row = db.prepare(`SELECT type FROM tracked_wallets WHERE address = '0xtest_type_${type}'`).get();
        assertEqual(row.type, type, `Type '${type}' must be accepted`);
        db.prepare(`DELETE FROM tracked_wallets WHERE address = '0xtest_type_${type}'`).run();
      }
    });

    test('type allows NULL for unscored wallets', () => {
      db.prepare(
        `
        INSERT OR REPLACE INTO tracked_wallets (address, chain, status)
        VALUES ('0xtest_null_type', 'base', 'proposed')
      `,
      ).run();
      const row = db.prepare("SELECT type FROM tracked_wallets WHERE address = '0xtest_null_type'").get();
      assertEqual(row.type, null, 'NULL type must be accepted');
      db.prepare("DELETE FROM tracked_wallets WHERE address = '0xtest_null_type'").run();
    });

    test('retry_count=2 still appears unscored; retry_count=3 does not', () => {
      db.prepare(
        `
        INSERT OR REPLACE INTO tracked_wallets (address, chain, status, retry_count)
        VALUES ('0xtest_retry2', 'base', 'failed', 2)
      `,
      ).run();
      db.prepare(
        `
        INSERT OR REPLACE INTO tracked_wallets (address, chain, status, retry_count)
        VALUES ('0xtest_retry3', 'base', 'failed', 3)
      `,
      ).run();
      const unscored = db
        .prepare(
          `
        SELECT address FROM tracked_wallets
        WHERE status = 'proposed' OR (status = 'failed' AND retry_count < 3)
      `,
        )
        .all()
        .map((r) => r.address);
      assert(unscored.includes('0xtest_retry2'), 'retry_count=2 must appear in unscored');
      assert(!unscored.includes('0xtest_retry3'), 'retry_count=3 must NOT appear in unscored');
      db.prepare("DELETE FROM tracked_wallets WHERE address IN ('0xtest_retry2', '0xtest_retry3')").run();
    });

    test('heartbeat_state has system/wallet_scoring', () => {
      const row = db
        .prepare("SELECT * FROM heartbeat_state WHERE agent = 'system' AND check_type = 'wallet_scoring'")
        .get();
      assert(row, 'system/wallet_scoring heartbeat state must exist');
    });

    // Cleanup
    test('cleanup test data', () => {
      db.prepare("DELETE FROM tracked_wallets WHERE address LIKE '0xtest_%'").run();
      assert(true, 'Cleanup ok');
    });
  });

  describe('Wallet Database — Contract Snapshots', () => {
    test('contract_snapshots has expected columns', () => {
      const cols = db
        .prepare('PRAGMA table_info(contract_snapshots)')
        .all()
        .map((c) => c.name);
      for (const col of ['id', 'address', 'chain', 'safety_data', 'checked_at']) {
        assert(cols.includes(col), `contract_snapshots must have column '${col}'`);
      }
    });

    test('can insert and query contract snapshot', () => {
      const safetyData = JSON.stringify({ is_honeypot: '0', is_proxy: '0', owner_address: '0xowner1' });
      db.prepare('INSERT INTO contract_snapshots (address, chain, safety_data) VALUES (?, ?, ?)').run(
        '0xtest_cs1',
        'base',
        safetyData,
      );
      const row = db
        .prepare('SELECT * FROM contract_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT 1')
        .get('0xtest_cs1', 'base');
      assert(row, 'Snapshot must be insertable and queryable');
      const parsed = JSON.parse(row.safety_data);
      assertEqual(parsed.is_honeypot, '0', 'Safety data must be preserved');
      assertEqual(parsed.owner_address, '0xowner1', 'Owner address must be preserved');
    });

    test('multiple snapshots per address ordered by id', () => {
      const data2 = JSON.stringify({ is_honeypot: '0', is_proxy: '1', owner_address: '0xowner2' });
      db.prepare('INSERT INTO contract_snapshots (address, chain, safety_data) VALUES (?, ?, ?)').run(
        '0xtest_cs1',
        'base',
        data2,
      );
      const rows = db
        .prepare('SELECT * FROM contract_snapshots WHERE address = ? AND chain = ? ORDER BY id DESC')
        .all('0xtest_cs1', 'base');
      assert(rows.length >= 2, 'Should have multiple snapshots');
      const latest = JSON.parse(rows[0].safety_data);
      assertEqual(latest.is_proxy, '1', 'Latest snapshot should be most recent');
    });

    test('cleanup contract snapshot test data', () => {
      db.prepare("DELETE FROM contract_snapshots WHERE address LIKE '0xtest_%'").run();
      assert(true, 'Cleanup ok');
    });
  });

  describe('Wallet Database — Analysis Cache', () => {
    test('analysis_cache table exists', () => {
      const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='analysis_cache'").get();
      assert(row, 'Table analysis_cache must exist');
    });

    test('analysis_cache has expected columns', () => {
      const cols = db
        .prepare('PRAGMA table_info(analysis_cache)')
        .all()
        .map((c) => c.name);
      for (const col of [
        'address',
        'chain',
        'symbol',
        'analysis_score',
        'risk_score',
        'verdict',
        'tier',
        'reasoning',
        'expires_at',
        'created_at',
      ]) {
        assert(cols.includes(col), `analysis_cache must have column '${col}'`);
      }
    });

    test('insert and query cache entry', () => {
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, verdict, expires_at)
        VALUES ('0xtest_cache1', 'base', 'TEST1', 'avoid', datetime('now', '+24 hours'))
      `,
      ).run();
      const row = db.prepare("SELECT * FROM analysis_cache WHERE address = '0xtest_cache1' AND chain = 'base'").get();
      assert(row, 'Cache entry must be insertable and queryable');
      assertEqual(row.verdict, 'avoid', 'Verdict must match');
      assertEqual(row.symbol, 'TEST1', 'Symbol must match');
    });

    test('upsert replaces existing entry', () => {
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, verdict, analysis_score, expires_at)
        VALUES ('0xtest_cache1', 'base', 'TEST1', 'risk_rejected', 45, datetime('now', '+12 hours'))
        ON CONFLICT(address, chain) DO UPDATE SET
          verdict = excluded.verdict, analysis_score = excluded.analysis_score,
          expires_at = excluded.expires_at
      `,
      ).run();
      const row = db.prepare("SELECT * FROM analysis_cache WHERE address = '0xtest_cache1' AND chain = 'base'").get();
      assertEqual(row.verdict, 'risk_rejected', 'Verdict must be updated');
      assertEqual(row.analysis_score, 45, 'Score must be updated');
    });

    test('expired entries excluded from active query', () => {
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, verdict, expires_at)
        VALUES ('0xtest_expired', 'base', 'EXPD', 'avoid', datetime('now', '-1 hours'))
      `,
      ).run();
      const rows = db
        .prepare("SELECT * FROM analysis_cache WHERE expires_at > datetime('now') AND address = '0xtest_expired'")
        .all();
      assertEqual(rows.length, 0, 'Expired entry must not appear in active query');
    });

    test('same address on different chains = separate entries', () => {
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, verdict, expires_at)
        VALUES ('0xtest_multi', 'base', 'MULTI', 'avoid', datetime('now', '+24 hours'))
      `,
      ).run();
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, verdict, expires_at)
        VALUES ('0xtest_multi', 'solana', 'MULTI', 'risk_rejected', datetime('now', '+24 hours'))
      `,
      ).run();
      const baseRow = db
        .prepare("SELECT verdict FROM analysis_cache WHERE address = '0xtest_multi' AND chain = 'base'")
        .get();
      const solRow = db
        .prepare("SELECT verdict FROM analysis_cache WHERE address = '0xtest_multi' AND chain = 'solana'")
        .get();
      assertEqual(baseRow.verdict, 'avoid', 'Base entry must have its own verdict');
      assertEqual(solRow.verdict, 'risk_rejected', 'Solana entry must have its own verdict');
    });

    test('cleanup analysis cache test data', () => {
      db.prepare("DELETE FROM analysis_cache WHERE address LIKE '0xtest_%'").run();
      assert(true, 'Cleanup ok');
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
