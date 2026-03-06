#!/usr/bin/env node
/**
 * db-query.js — CLI interface for agents to read/write wallet data in SQLite
 *
 * This is the bridge between agents (who speak JSON) and the database.
 * Agents call this script instead of reading/writing JSON files.
 *
 * Usage:
 *   node scripts/db-query.js <command> [options]
 *
 * Commands:
 *   # Positions
 *   get-positions [--status open|closed|all]
 *   get-position --id <id>
 *   add-position --json '<json>'
 *   update-position --id <id> --json '<json>'
 *   remove-position --id <id>
 *
 *   # Portfolio
 *   get-portfolio                         # positions + cash + meta
 *   get-cash
 *   set-cash --amount <number>
 *   get-meta --key <key>
 *   set-meta --key <key> --value <value>
 *
 *   # Approved trades
 *   get-approved-trades [--pending]       # --pending = executed=0
 *   add-approved-trade --json '<json>'
 *   mark-trade-executed --id <id>
 *
 *   # Sell orders
 *   get-sell-orders [--pending]
 *   add-sell-order --json '<json>'
 *   mark-sell-executed --id <id>
 *
 *   # Trade receipts
 *   add-receipt --json '<json>'
 *   get-receipts [--status <status>] [--limit <n>]
 *   get-receipt --id <id>
 *
 *   # Alerts
 *   get-alerts [--unprocessed]
 *   add-alert --json '<json>'
 *   mark-alert-processed --id <id>
 *
 *   # Watchlist
 *   get-watchlist [--active]
 *   add-to-watchlist --json '<json>'
 *   update-watchlist --id <id> --json '<json>'
 *   remove-from-watchlist --id <id>
 *
 *   # Liquidity
 *   get-liquidity --address <addr> --chain <chain> [--limit 2]
 *   add-liquidity-snapshot --address <addr> --chain <chain> --liquidity <usd>
 *
 *   # Tracked wallets
 *   get-tracked-wallets
 *   add-tracked-wallet --json '<json>'
 *   remove-tracked-wallet --address <addr> --chain <chain>
 *
 *   # Heartbeat
 *   get-heartbeat --agent <name>
 *   update-heartbeat --agent <name> --check <type>
 *
 *   # Logs
 *   add-sentinel-log --json '<json>'
 *   add-executor-log --json '<json>'
 *   get-sentinel-log [--limit 50]
 *   get-executor-log [--limit 50]
 *
 *   # Trade history
 *   add-trade --json '<json>'
 *   get-trades [--limit 50]
 *   get-trade-stats
 *
 *   # Admin
 *   migrate                                # Run pending DB migrations
 *
 * All output is JSON to stdout. Errors go to stderr with exit code 1.
 */

import { getDb, close } from './db.js';

const args = process.argv.slice(2);
const command = args[0];

function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return null;
  return args[idx + 1];
}

function hasFlag(name) {
  return args.includes(`--${name}`);
}

function parseJson(name) {
  const raw = getArg(name || 'json');
  if (!raw) { error(`Missing --${name || 'json'} argument`); }
  try {
    return JSON.parse(raw);
  } catch (e) {
    error(`Invalid JSON in --${name || 'json'}: ${e.message}`);
  }
}

function output(data) {
  console.log(JSON.stringify(data, null, 2));
}

function error(msg) {
  console.error(JSON.stringify({ error: msg }));
  process.exit(1);
}

try {
  const db = getDb();
  handle(db, command);
  close();
} catch (e) {
  error(e.message);
}

function handle(db, cmd) {
  switch (cmd) {
    // ============================================================
    // Positions
    // ============================================================
    case 'get-positions': {
      const status = getArg('status') || 'open';
      const rows = status === 'all'
        ? db.prepare('SELECT * FROM positions ORDER BY created_at DESC').all()
        : db.prepare('SELECT * FROM positions WHERE status = ? ORDER BY created_at DESC').all(status);
      // Parse JSON fields
      output(rows.map(r => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) })));
      break;
    }
    case 'get-position': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      const row = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
      if (!row) error(`Position not found: ${id}`);
      output({ ...row, take_profit_levels: JSON.parse(row.take_profit_levels) });
      break;
    }
    case 'add-position': {
      const p = parseJson();
      db.prepare(`
        INSERT INTO positions (id, symbol, name, address, chain, tier, entry_price, current_price,
          quantity, value_usd, percent_of_portfolio, entry_date, stop_loss, take_profit_levels,
          narrative, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(p.id, p.symbol, p.name, p.address, p.chain, p.tier, p.entry_price, p.current_price,
        p.quantity, p.value_usd, p.percent_of_portfolio, p.entry_date || new Date().toISOString().split('T')[0],
        p.stop_loss, JSON.stringify(p.take_profit_levels), p.narrative, p.status || 'open', p.notes);
      output({ ok: true, id: p.id });
      break;
    }
    case 'update-position': {
      const id = getArg('id');
      const updates = parseJson();
      if (!id) error('Missing --id');
      const fields = Object.keys(updates);
      const setClauses = fields.map(f =>
        f === 'take_profit_levels' ? `${f} = ?` : `${f} = ?`
      ).join(', ');
      const values = fields.map(f =>
        f === 'take_profit_levels' ? JSON.stringify(updates[f]) : updates[f]
      );
      db.prepare(`UPDATE positions SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
      output({ ok: true, id });
      break;
    }
    case 'remove-position': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE positions SET status = 'closed', updated_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Portfolio
    // ============================================================
    case 'get-portfolio': {
      const positions = db.prepare("SELECT * FROM positions WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC").all()
        .map(r => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) }));
      const cash = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash'").get()?.value || '0');
      const totalDeposited = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'total_deposited'").get()?.value || '0');
      const safeId = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'safe_id'").get()?.value;
      output({ safe_id: safeId, cash, total_deposited: totalDeposited, positions });
      break;
    }
    case 'get-cash': {
      const cash = parseFloat(db.prepare("SELECT value FROM portfolio_meta WHERE key = 'cash'").get()?.value || '0');
      output({ cash });
      break;
    }
    case 'set-cash': {
      const amount = getArg('amount');
      if (amount === null) error('Missing --amount');
      db.prepare("UPDATE portfolio_meta SET value = ?, updated_at = datetime('now') WHERE key = 'cash'").run(String(amount));
      output({ ok: true, cash: parseFloat(amount) });
      break;
    }
    case 'get-meta': {
      const key = getArg('key');
      if (!key) error('Missing --key');
      const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(key);
      output({ key, value: row?.value || null });
      break;
    }
    case 'set-meta': {
      const key = getArg('key');
      const value = getArg('value');
      if (!key || value === null) error('Missing --key or --value');
      db.prepare(`
        INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `).run(key, value, value);
      output({ ok: true, key, value });
      break;
    }

    // ============================================================
    // Approved trades
    // ============================================================
    case 'get-approved-trades': {
      const rows = hasFlag('pending')
        ? db.prepare('SELECT * FROM approved_trades WHERE executed = 0 ORDER BY created_at ASC').all()
        : db.prepare('SELECT * FROM approved_trades ORDER BY created_at DESC').all();
      output(rows.map(r => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) })));
      break;
    }
    case 'add-approved-trade': {
      const t = parseJson();
      db.prepare(`
        INSERT INTO approved_trades (id, symbol, name, address, chain, amount, percent_of_portfolio,
          tier, entry_price, stop_loss, take_profit_levels, analysis_score, risk_score, reasoning,
          approved, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.id, t.symbol, t.name, t.address, t.chain, t.amount, t.percent_of_portfolio,
        t.tier, t.entry_price, t.stop_loss, JSON.stringify(t.take_profit_levels),
        t.analysis_score, t.risk_score, t.reasoning,
        t.approved ? 1 : 0, t.approved_at, t.approved_by || 'human');
      output({ ok: true, id: t.id });
      break;
    }
    case 'mark-trade-executed': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE approved_trades SET executed = 1, executed_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Sell orders
    // ============================================================
    case 'get-sell-orders': {
      const rows = hasFlag('pending')
        ? db.prepare('SELECT * FROM sell_orders WHERE executed = 0 ORDER BY created_at ASC').all()
        : db.prepare('SELECT * FROM sell_orders ORDER BY created_at DESC').all();
      output(rows);
      break;
    }
    case 'add-sell-order': {
      const s = parseJson();
      db.prepare(`
        INSERT INTO sell_orders (id, symbol, address, chain, amount, reason, urgency)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(s.id, s.symbol, s.address, s.chain, s.amount, s.reason, s.urgency || 'immediate');
      output({ ok: true, id: s.id });
      break;
    }
    case 'mark-sell-executed': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE sell_orders SET executed = 1, executed_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Trade receipts
    // ============================================================
    case 'add-receipt': {
      const r = parseJson();
      db.prepare(`
        INSERT INTO trade_receipts (id, order_id, order_source, action, symbol, address, chain,
          amount, quantity, expected_price, executed_price, slippage, status, safe_tx_hash,
          onchain_tx_hash, safe_nonce, signatures_collected, signatures_required, gas_used, error, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(r.id, r.order_id, r.order_source, r.action, r.symbol, r.address, r.chain,
        r.amount, r.quantity, r.expected_price, r.executed_price, r.slippage, r.status,
        r.safe_tx_hash, r.onchain_tx_hash, r.safe_nonce, r.signatures_collected,
        r.signatures_required, r.gas_used, r.error, r.notes);
      output({ ok: true, id: r.id });
      break;
    }
    case 'get-receipts': {
      const status = getArg('status');
      const limit = parseInt(getArg('limit') || '50');
      const rows = status
        ? db.prepare('SELECT * FROM trade_receipts WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM trade_receipts ORDER BY created_at DESC LIMIT ?').all(limit);
      output(rows);
      break;
    }
    case 'get-receipt': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      const row = db.prepare('SELECT * FROM trade_receipts WHERE id = ?').get(id);
      if (!row) error(`Receipt not found: ${id}`);
      output(row);
      break;
    }

    // ============================================================
    // Alerts
    // ============================================================
    case 'get-alerts': {
      const rows = hasFlag('unprocessed')
        ? db.prepare('SELECT * FROM sentinel_alerts WHERE processed = 0 ORDER BY created_at DESC').all()
        : db.prepare('SELECT * FROM sentinel_alerts ORDER BY created_at DESC LIMIT 100').all();
      output(rows);
      break;
    }
    case 'add-alert': {
      const a = parseJson();
      db.prepare(`
        INSERT INTO sentinel_alerts (id, symbol, chain, alert_type, severity, current_price,
          trigger_price, details, action, sell_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(a.id, a.symbol, a.chain, a.alert_type, a.severity, a.current_price,
        a.trigger_price, a.details, a.action, a.sell_amount);
      output({ ok: true, id: a.id });
      break;
    }
    case 'mark-alert-processed': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE sentinel_alerts SET processed = 1, processed_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Watchlist
    // ============================================================
    case 'get-watchlist': {
      const rows = hasFlag('active')
        ? db.prepare("SELECT * FROM watchlist WHERE status = 'watching' ORDER BY created_at DESC").all()
        : db.prepare('SELECT * FROM watchlist ORDER BY created_at DESC').all();
      output(rows);
      break;
    }
    case 'add-to-watchlist': {
      const w = parseJson();
      db.prepare(`
        INSERT INTO watchlist (id, symbol, address, chain, target_entry, current_price,
          analysis_score, risk_score, narrative, reason, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(w.id, w.symbol, w.address, w.chain, w.target_entry, w.current_price,
        w.analysis_score, w.risk_score, w.narrative, w.reason, w.expires_at, w.status || 'watching');
      output({ ok: true, id: w.id });
      break;
    }
    case 'update-watchlist': {
      const id = getArg('id');
      const updates = parseJson();
      if (!id) error('Missing --id');
      const fields = Object.keys(updates);
      const setClauses = fields.map(f => `${f} = ?`).join(', ');
      const values = fields.map(f => updates[f]);
      db.prepare(`UPDATE watchlist SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(...values, id);
      output({ ok: true, id });
      break;
    }
    case 'remove-from-watchlist': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE watchlist SET status = 'removed', updated_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Liquidity
    // ============================================================
    case 'get-liquidity': {
      const address = getArg('address');
      const chain = getArg('chain');
      const limit = parseInt(getArg('limit') || '2');
      if (!address || !chain) error('Missing --address or --chain');
      const rows = db.prepare(
        'SELECT * FROM liquidity_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT ?'
      ).all(address, chain, limit);
      output(rows);
      break;
    }
    case 'add-liquidity-snapshot': {
      const address = getArg('address');
      const chain = getArg('chain');
      const liquidity = getArg('liquidity');
      if (!address || !chain || liquidity === null) error('Missing --address, --chain, or --liquidity');
      db.prepare(
        'INSERT INTO liquidity_snapshots (address, chain, liquidity_usd) VALUES (?, ?, ?)'
      ).run(address, chain, parseFloat(liquidity));
      output({ ok: true });
      break;
    }

    // ============================================================
    // Tracked wallets
    // ============================================================
    case 'get-tracked-wallets': {
      output(db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all());
      break;
    }
    case 'add-tracked-wallet': {
      const w = parseJson();
      db.prepare(`
        INSERT OR REPLACE INTO tracked_wallets (address, chain, label, type, notes)
        VALUES (?, ?, ?, ?, ?)
      `).run(w.address, w.chain, w.label, w.type, w.notes);
      output({ ok: true, address: w.address });
      break;
    }
    case 'remove-tracked-wallet': {
      const address = getArg('address');
      const chain = getArg('chain');
      if (!address || !chain) error('Missing --address or --chain');
      db.prepare('DELETE FROM tracked_wallets WHERE address = ? AND chain = ?').run(address, chain);
      output({ ok: true });
      break;
    }

    // ============================================================
    // Heartbeat
    // ============================================================
    case 'get-heartbeat': {
      const agent = getArg('agent');
      if (!agent) error('Missing --agent');
      output(db.prepare('SELECT * FROM heartbeat_state WHERE agent = ?').all(agent));
      break;
    }
    case 'update-heartbeat': {
      const agent = getArg('agent');
      const check = getArg('check');
      if (!agent || !check) error('Missing --agent or --check');
      db.prepare("UPDATE heartbeat_state SET last_run = datetime('now') WHERE agent = ? AND check_type = ?").run(agent, check);
      output({ ok: true });
      break;
    }

    // ============================================================
    // Logs
    // ============================================================
    case 'add-sentinel-log': {
      const l = parseJson();
      db.prepare(`
        INSERT INTO sentinel_log (check_type, positions_checked, alerts_generated, sells_executed, status)
        VALUES (?, ?, ?, ?, ?)
      `).run(l.check_type, l.positions_checked || 0, l.alerts_generated || 0, l.sells_executed || 0, l.status || 'ok');
      output({ ok: true });
      break;
    }
    case 'add-executor-log': {
      const l = parseJson();
      db.prepare(`
        INSERT INTO executor_log (sell_orders_processed, buy_orders_processed, pending_checked,
          success_count, fail_count, queued_count, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(l.sell_orders_processed || 0, l.buy_orders_processed || 0, l.pending_checked || 0,
        l.success_count || 0, l.fail_count || 0, l.queued_count || 0, l.status || 'ok');
      output({ ok: true });
      break;
    }
    case 'get-sentinel-log': {
      const limit = parseInt(getArg('limit') || '50');
      output(db.prepare('SELECT * FROM sentinel_log ORDER BY created_at DESC LIMIT ?').all(limit));
      break;
    }
    case 'get-executor-log': {
      const limit = parseInt(getArg('limit') || '50');
      output(db.prepare('SELECT * FROM executor_log ORDER BY created_at DESC LIMIT ?').all(limit));
      break;
    }

    // ============================================================
    // Trade history
    // ============================================================
    case 'add-trade': {
      const t = parseJson();
      db.prepare(`
        INSERT INTO trades (id, symbol, address, chain, tier, action, entry_price, exit_price,
          quantity, entry_date, exit_date, pnl_percent, pnl_usd, exit_reason, analysis_score,
          risk_score, narrative, lesson, duration_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(t.id, t.symbol, t.address, t.chain, t.tier, t.action, t.entry_price, t.exit_price,
        t.quantity, t.entry_date, t.exit_date, t.pnl_percent, t.pnl_usd, t.exit_reason,
        t.analysis_score, t.risk_score, t.narrative, t.lesson, t.duration_days);
      output({ ok: true, id: t.id });
      break;
    }
    case 'get-trades': {
      const limit = parseInt(getArg('limit') || '50');
      output(db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit));
      break;
    }
    case 'get-trade-stats': {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losses,
          ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_percent END), 2) as avg_win_percent,
          ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_percent END), 2) as avg_loss_percent,
          ROUND(SUM(pnl_usd), 2) as total_pnl_usd,
          MAX(pnl_usd) as best_trade_pnl,
          MIN(pnl_usd) as worst_trade_pnl
        FROM trades
      `).get();
      stats.win_rate = stats.total_trades > 0 ? Math.round((stats.wins / stats.total_trades) * 100) : 0;
      output(stats);
      break;
    }

    // ============================================================
    // Migrations
    // ============================================================
    case 'migrate': {
      // getDb() already ran migrations — if we got here, they succeeded
      const applied = db.prepare('SELECT name, applied_at FROM _migrations ORDER BY id').all();
      output({ ok: true, safe_id: process.env.SAFE_ID || 'default', migrations: applied });
      break;
    }

    default:
      error(`Unknown command: ${cmd}. Run without args for help.`);
  }
}
