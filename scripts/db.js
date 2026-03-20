/**
 * db.js — SQLite data access layer for wallet-specific memory
 *
 * All wallet/fund data lives here: positions, trades, orders, alerts, receipts.
 * Agent-specific memory (patterns, lessons, daily logs) stays in markdown files.
 *
 * Usage:
 *   import { getDb, close } from './db.js';
 *   const db = getDb();
 *   const positions = db.prepare('SELECT * FROM positions WHERE status = ?').all('open');
 *
 * The DB path comes from env: DB_PATH (default: ./data/<SAFE_ID>.db)
 * SAFE_ID identifies the fund/wallet this deployment manages.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { config } from 'dotenv';

config();

const SAFE_ID = process.env.SAFE_ID || 'default';
const DB_PATH = process.env.DB_PATH || resolve(process.cwd(), 'data', `${SAFE_ID}.db`);

let _db = null;

export function getDb() {
  if (_db) return _db;

  // Ensure data directory exists
  const dir = dirname(DB_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  _db = new Database(DB_PATH);

  // Performance settings
  _db.pragma('journal_mode = WAL');
  _db.pragma('synchronous = NORMAL');
  _db.pragma('foreign_keys = ON');

  // Run migrations
  migrate(_db);

  return _db;
}

export function close() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

// ============================================================
// Migrations
// ============================================================

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const applied = new Set(
    db
      .prepare('SELECT name FROM _migrations')
      .all()
      .map((r) => r.name),
  );

  for (const m of migrations) {
    if (!applied.has(m.name)) {
      // Wrap each migration in a transaction — all-or-nothing
      const runMigration = db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(m.name);
      });

      try {
        runMigration();
        console.error(`[db] Migration applied: ${m.name}`);
      } catch (e) {
        console.error(`[db] Migration FAILED: ${m.name} — ${e.message}`);
        throw e;
      }
    }
  }
}

const migrations = [
  {
    name: '001_initial',
    sql: `
      -- Portfolio positions
      CREATE TABLE positions (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('base', 'conviction', 'moonshot')),
        entry_price REAL NOT NULL,
        current_price REAL,
        quantity REAL NOT NULL,
        value_usd REAL,
        percent_of_portfolio REAL,
        entry_date TEXT NOT NULL DEFAULT (date('now')),
        stop_loss REAL NOT NULL,
        take_profit_levels TEXT NOT NULL, -- JSON array
        narrative TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial_exit', 'closed')),
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Trade history (closed trades with P&L)
      CREATE TABLE trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        entry_price REAL,
        exit_price REAL,
        quantity REAL NOT NULL,
        entry_date TEXT,
        exit_date TEXT,
        pnl_percent REAL,
        pnl_usd REAL,
        exit_reason TEXT,
        analysis_score INTEGER,
        risk_score INTEGER,
        narrative TEXT,
        lesson TEXT,
        duration_days INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Approved buy trades (Research → Executor)
      CREATE TABLE approved_trades (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        amount REAL NOT NULL,
        percent_of_portfolio REAL NOT NULL,
        tier TEXT NOT NULL,
        entry_price REAL NOT NULL,
        stop_loss REAL NOT NULL,
        take_profit_levels TEXT NOT NULL, -- JSON array
        analysis_score INTEGER,
        risk_score INTEGER,
        reasoning TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        approved_by TEXT DEFAULT 'human',
        executed INTEGER NOT NULL DEFAULT 0,
        executed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Sell orders (Sentinel → Executor)
      CREATE TABLE sell_orders (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        amount TEXT NOT NULL, -- 'all', '50%', '30%'
        reason TEXT NOT NULL,
        urgency TEXT NOT NULL DEFAULT 'immediate',
        executed INTEGER NOT NULL DEFAULT 0,
        executed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Trade receipts (Executor output)
      CREATE TABLE trade_receipts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_source TEXT NOT NULL CHECK (order_source IN ('approved_trades', 'sell_orders')),
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        amount REAL,
        quantity REAL,
        expected_price REAL,
        executed_price REAL,
        slippage REAL,
        status TEXT NOT NULL CHECK (status IN ('executed', 'queued_in_safe', 'validation_failed', 'tx_failed', 'reverted')),
        safe_tx_hash TEXT,
        onchain_tx_hash TEXT,
        safe_nonce INTEGER,
        signatures_collected INTEGER,
        signatures_required INTEGER,
        gas_used TEXT,
        error TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Sentinel alerts
      CREATE TABLE sentinel_alerts (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        chain TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL CHECK (severity IN ('critical', 'high', 'medium', 'low')),
        current_price REAL,
        trigger_price REAL,
        details TEXT,
        action TEXT,
        sell_amount TEXT,
        processed INTEGER NOT NULL DEFAULT 0,
        processed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Watchlist
      CREATE TABLE watchlist (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        target_entry REAL,
        current_price REAL,
        analysis_score INTEGER,
        risk_score INTEGER,
        narrative TEXT,
        reason TEXT,
        expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'watching' CHECK (status IN ('watching', 'entry_hit', 'expired', 'removed')),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Liquidity snapshots
      CREATE TABLE liquidity_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        liquidity_usd REAL NOT NULL,
        checked_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_liquidity_address ON liquidity_snapshots(address, chain);

      -- Tracked wallets (smart money)
      CREATE TABLE tracked_wallets (
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        label TEXT,
        type TEXT CHECK (type IN ('smart_money', 'dev', 'whale')),
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (address, chain)
      );

      -- Heartbeat state
      CREATE TABLE heartbeat_state (
        agent TEXT NOT NULL,
        check_type TEXT NOT NULL,
        last_run TEXT,
        PRIMARY KEY (agent, check_type)
      );

      -- Sentinel log (append-only)
      CREATE TABLE sentinel_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_type TEXT NOT NULL,
        positions_checked INTEGER DEFAULT 0,
        alerts_generated INTEGER DEFAULT 0,
        sells_executed INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Executor log (append-only)
      CREATE TABLE executor_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sell_orders_processed INTEGER DEFAULT 0,
        buy_orders_processed INTEGER DEFAULT 0,
        pending_checked INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        queued_count INTEGER DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'ok',
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Portfolio metadata
      CREATE TABLE portfolio_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Seed portfolio meta
      INSERT INTO portfolio_meta (key, value) VALUES ('cash', '0');
      INSERT INTO portfolio_meta (key, value) VALUES ('total_deposited', '0');
      INSERT INTO portfolio_meta (key, value) VALUES ('safe_id', '${SAFE_ID}');

      -- Init heartbeat state for all agents
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'sentinel_alerts');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'token_scan');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'smart_money');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'narrative_check');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'rebalance_review');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'daily_summary');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('research', 'watchlist_check');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('sentinel', 'price_check');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('sentinel', 'liquidity_check');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('sentinel', 'wallet_check');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('executor', 'process_orders');
      INSERT INTO heartbeat_state (agent, check_type) VALUES ('executor', 'check_pending');
    `,
  },
  {
    name: '002_paper_mode',
    sql: `
      -- Paper trades: what WOULD have been executed
      CREATE TABLE paper_trades (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        order_source TEXT NOT NULL CHECK (order_source IN ('approved_trades', 'sell_orders')),
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT,
        proposed_price REAL NOT NULL,
        quantity REAL,
        amount REAL,
        stop_loss REAL,
        take_profit_levels TEXT,
        reasoning TEXT,
        pnl_percent REAL,
        pnl_usd REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Paper positions: simulated portfolio
      CREATE TABLE paper_positions (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT NOT NULL,
        entry_price REAL NOT NULL,
        current_price REAL,
        quantity REAL NOT NULL,
        value_usd REAL,
        entry_date TEXT NOT NULL DEFAULT (date('now')),
        stop_loss REAL NOT NULL,
        take_profit_levels TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial_exit', 'closed')),
        exit_price REAL,
        exit_date TEXT,
        pnl_percent REAL,
        pnl_usd REAL,
        exit_reason TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      -- Seed paper portfolio meta
      INSERT OR IGNORE INTO portfolio_meta (key, value) VALUES ('paper_cash', '10000');
      INSERT OR IGNORE INTO portfolio_meta (key, value) VALUES ('paper_initial_balance', '10000');
    `,
  },
  {
    name: '003_tracked_wallets_deployer_type',
    sql: `
      -- Expand tracked_wallets type constraint to include 'deployer'
      CREATE TABLE tracked_wallets_new (
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        label TEXT,
        type TEXT CHECK (type IN ('smart_money', 'dev', 'whale', 'deployer')),
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (address, chain)
      );
      INSERT INTO tracked_wallets_new SELECT * FROM tracked_wallets;
      DROP TABLE tracked_wallets;
      ALTER TABLE tracked_wallets_new RENAME TO tracked_wallets;
    `,
  },
  {
    name: '004_wallet_scoring_pipeline',
    sql: `
      -- Recreate tracked_wallets with scoring pipeline columns
      -- Expand type to include 'trader' and 'retail', allow NULL for unscored
      CREATE TABLE tracked_wallets_new (
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        label TEXT,
        type TEXT CHECK (type IN ('smart_money', 'dev', 'whale', 'deployer', 'trader', 'retail')),
        notes TEXT,
        status TEXT NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'scoring', 'scored', 'failed')),
        score INTEGER,
        score_breakdown TEXT,
        source_token TEXT,
        scored_at TEXT,
        score_error TEXT,
        retry_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (address, chain)
      );
      INSERT INTO tracked_wallets_new (address, chain, label, type, notes, status, created_at)
        SELECT address, chain, label, type, notes, 'scored', created_at FROM tracked_wallets;
      DROP TABLE tracked_wallets;
      ALTER TABLE tracked_wallets_new RENAME TO tracked_wallets;

      -- Seed heartbeat state for background wallet scoring
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('system', 'wallet_scoring');
    `,
  },
  {
    name: '005_market_regime',
    sql: `
      -- Seed market regime metadata
      INSERT OR IGNORE INTO portfolio_meta (key, value) VALUES ('market_regime', 'neutral');
      INSERT OR IGNORE INTO portfolio_meta (key, value) VALUES ('market_regime_history', '[]');

      -- Seed heartbeat state for market regime check
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('research', 'market_regime');
    `,
  },
  {
    name: '006_analysis_cache',
    sql: `
      -- Cache for analysis/risk verdicts to prevent redundant sub-agent spawns
      CREATE TABLE analysis_cache (
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        symbol TEXT,
        analysis_score INTEGER,
        risk_score INTEGER,
        verdict TEXT NOT NULL,
        tier TEXT,
        reasoning TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT DEFAULT (datetime('now')),
        PRIMARY KEY (address, chain)
      );
      CREATE INDEX idx_analysis_cache_expires ON analysis_cache(expires_at);
    `,
  },
  {
    name: '007_wallet_source',
    sql: `
      ALTER TABLE tracked_wallets ADD COLUMN source TEXT DEFAULT 'agent';
    `,
  },
  {
    name: '008_portfolio_sync',
    sql: `
      -- Track on-chain portfolio sync state
      CREATE TABLE portfolio_sync (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chain TEXT NOT NULL,
        provider TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('success', 'error')),
        positions_synced INTEGER DEFAULT 0,
        positions_closed INTEGER DEFAULT 0,
        positions_discovered INTEGER DEFAULT 0,
        error TEXT,
        synced_at TEXT DEFAULT (datetime('now'))
      );

      -- Add sync metadata to positions
      ALTER TABLE positions ADD COLUMN onchain_balance REAL;
      ALTER TABLE positions ADD COLUMN last_synced_at TEXT;

      -- Extend positions status to include 'pending_analysis'
      -- SQLite requires table recreation to change CHECK constraints
      CREATE TABLE positions_new (
        id TEXT PRIMARY KEY,
        symbol TEXT NOT NULL,
        name TEXT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT NOT NULL CHECK (tier IN ('base', 'conviction', 'moonshot')),
        entry_price REAL NOT NULL,
        current_price REAL,
        quantity REAL NOT NULL,
        value_usd REAL,
        percent_of_portfolio REAL,
        entry_date TEXT NOT NULL DEFAULT (date('now')),
        stop_loss REAL NOT NULL,
        take_profit_levels TEXT NOT NULL,
        narrative TEXT,
        status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'partial_exit', 'closed', 'pending_analysis')),
        notes TEXT,
        onchain_balance REAL,
        last_synced_at TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      INSERT INTO positions_new SELECT id, symbol, name, address, chain, tier, entry_price, current_price,
        quantity, value_usd, percent_of_portfolio, entry_date, stop_loss, take_profit_levels, narrative,
        status, notes, onchain_balance, last_synced_at, created_at, updated_at FROM positions;
      DROP TABLE positions;
      ALTER TABLE positions_new RENAME TO positions;

      -- Seed heartbeat state for portfolio sync
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('sentinel', 'portfolio_sync');
    `,
  },
  {
    name: '009_per_chain_cash',
    sql: `
      -- Migrate existing global cash → per-chain
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('cash_base', COALESCE((SELECT value FROM portfolio_meta WHERE key = 'cash'), '0'));
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('cash_solana', '0');

      -- Paper mode per-chain
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('paper_cash_base', COALESCE((SELECT value FROM portfolio_meta WHERE key = 'paper_cash'), '10000'));
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('paper_cash_solana', '0');

      -- Per-chain initial balance
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('paper_initial_balance_base', COALESCE((SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance'), '10000'));
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('paper_initial_balance_solana', '0');

      -- Per-chain total deposited
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('total_deposited_base', COALESCE((SELECT value FROM portfolio_meta WHERE key = 'total_deposited'), '0'));
      INSERT OR IGNORE INTO portfolio_meta (key, value)
        VALUES ('total_deposited_solana', '0');
    `,
  },
  {
    name: '010_heartbeat_seeds_research',
    sql: `
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('research', 'conviction_scan');
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('research', 'base_rebalance');
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('research', 'portfolio_sync');
    `,
  },
  {
    name: '011_position_exit_columns',
    sql: `
      -- Add exit accounting columns to positions (mirroring paper_positions)
      ALTER TABLE positions ADD COLUMN exit_price REAL;
      ALTER TABLE positions ADD COLUMN exit_date TEXT;
      ALTER TABLE positions ADD COLUMN pnl_percent REAL;
      ALTER TABLE positions ADD COLUMN pnl_usd REAL;
      ALTER TABLE positions ADD COLUMN exit_reason TEXT;
    `,
  },
  {
    name: '012_unified_orders',
    sql: `
      -- Unified orders table (replaces approved_trades + sell_orders)
      CREATE TABLE orders (
        id TEXT PRIMARY KEY,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        symbol TEXT NOT NULL,
        name TEXT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        amount TEXT NOT NULL,
        percent_of_portfolio REAL,
        tier TEXT,
        entry_price REAL,
        stop_loss REAL,
        take_profit_levels TEXT,
        analysis_score INTEGER,
        risk_score INTEGER,
        reasoning TEXT,
        reason TEXT,
        urgency TEXT,
        approved INTEGER NOT NULL DEFAULT 0,
        approved_at TEXT,
        approved_by TEXT,
        executed INTEGER NOT NULL DEFAULT 0,
        executed_at TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Receipts table (replaces trade_receipts, no order_source)
      CREATE TABLE receipts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        amount REAL,
        quantity REAL,
        expected_price REAL,
        executed_price REAL,
        slippage REAL,
        status TEXT NOT NULL CHECK (status IN ('executed', 'queued_in_safe', 'queued_in_squads', 'validation_failed', 'tx_failed', 'reverted')),
        safe_tx_hash TEXT,
        onchain_tx_hash TEXT,
        safe_nonce INTEGER,
        signatures_collected INTEGER,
        signatures_required INTEGER,
        gas_used TEXT,
        error TEXT,
        notes TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      -- Paper receipts table (replaces paper_trades, no order_source)
      CREATE TABLE paper_receipts (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('buy', 'sell')),
        symbol TEXT NOT NULL,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        tier TEXT,
        proposed_price REAL NOT NULL,
        quantity REAL,
        amount REAL,
        stop_loss REAL,
        take_profit_levels TEXT,
        reasoning TEXT,
        pnl_percent REAL,
        pnl_usd REAL,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `,
  },
  {
    name: '013_contract_snapshots',
    sql: `
      -- Contract safety snapshots for change detection
      CREATE TABLE contract_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        address TEXT NOT NULL,
        chain TEXT NOT NULL,
        safety_data TEXT NOT NULL,
        checked_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX idx_contract_snapshots ON contract_snapshots(address, chain);

      -- Seed heartbeat state for contract monitoring
      INSERT OR IGNORE INTO heartbeat_state (agent, check_type) VALUES ('sentinel', 'contract_check');
    `,
  },
];

export default { getDb, close };
