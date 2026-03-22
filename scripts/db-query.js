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
 *   get-positions [--status open|closed|all] [--symbol TOKEN]
 *   get-position --id <id>
 *   add-position --json '<json>'
 *   update-position --id <id> --json '<json>'
 *   remove-position --id <id>
 *   close-position --id <id> --json '{"exit_price":...,"exit_reason":...}' [--quantity <sold_qty>]
 *
 *   # Portfolio
 *   get-portfolio                         # positions + cash + meta
 *   get-cash
 *   set-cash --amount <number>
 *   get-meta --key <key>
 *   set-meta --key <key> --value <value>
 *
 *   # Orders (unified: buys + sells)
 *   get-orders [--pending] [--action buy|sell]
 *   add-order --json '<json>'
 *   mark-order-executed --id <id>
 *
 *   # Receipts
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
 *   # Contract Snapshots
 *   get-contract-snapshots --address <addr> --chain <chain> [--limit 5]
 *   add-contract-snapshot --address <addr> --chain <chain> --json '<safety_data>'
 *
 *   # Tracked wallets
 *   get-tracked-wallets [--status <status>]
 *   add-tracked-wallet --json '<json>'
 *   remove-tracked-wallet --address <addr> --chain <chain>
 *   propose-wallet --json '<json>'             # Fast insert, status=proposed
 *   get-unscored-wallets [--limit 5]           # proposed + failed (retry<3)
 *   update-wallet-score --address <addr> --chain <chain> --json '<json>'
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
 *   # Paper mode
 *   add-paper-receipt --json '<json>'
 *   get-paper-receipts [--limit 50]
 *   get-paper-positions [--status open|closed|all] [--symbol TOKEN]
 *   add-paper-position --json '<json>'
 *   update-paper-position --id <id> --json '<json>'
 *   close-paper-position --id <id> --json '<json>'
 *   get-paper-portfolio
 *   get-paper-cash
 *   set-paper-cash --amount <number>
 *   get-paper-stats
 *
 *   # Analysis Cache (dedup)
 *   check-token-status --address <addr> --chain <chain>  # Check if token needs analysis
 *   cache-analysis --json '<json>'                       # Cache avoid/reject verdict
 *   get-analysis-cache                                   # List unexpired cache entries
 *   clear-expired-cache                                  # Delete expired cache entries
 *
 *   # Admin
 *   migrate                                # Run pending DB migrations
 *
 * All output is JSON to stdout. Errors go to stderr with exit code 1.
 */

import { getDb, close } from './db.js';
import { execSync } from 'child_process';
import { getAllChains, isSolana } from './chains.js';

function cashKey(chain, paper = false) {
  return `${paper ? 'paper_cash' : 'cash'}_${chain}`;
}

function getAllCashBreakdown(db, paper = false) {
  const prefix = paper ? 'paper_cash_' : 'cash_';
  const rows = db.prepare("SELECT key, value FROM portfolio_meta WHERE key LIKE ? || '%'").all(prefix);
  const perChain = {};
  let total = 0;
  for (const r of rows) {
    const chain = r.key.slice(prefix.length);
    if (!chain) continue; // skip exact prefix match (e.g. 'paper_cash' without chain suffix)
    const val = parseFloat(r.value || '0');
    perChain[chain] = val;
    total += val;
  }
  return { ...perChain, total };
}

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
  if (!raw) {
    error(`Missing --${name || 'json'} argument`);
  }
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
      const symbol = getArg('symbol');
      let rows;
      if (symbol) {
        rows =
          status === 'all'
            ? db.prepare('SELECT * FROM positions WHERE symbol = ? ORDER BY created_at DESC').all(symbol)
            : db
                .prepare('SELECT * FROM positions WHERE status = ? AND symbol = ? ORDER BY created_at DESC')
                .all(status, symbol);
      } else {
        rows =
          status === 'all'
            ? db.prepare('SELECT * FROM positions ORDER BY created_at DESC').all()
            : db.prepare('SELECT * FROM positions WHERE status = ? ORDER BY created_at DESC').all(status);
      }
      // Parse JSON fields
      output(rows.map((r) => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) })));
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
      db.prepare(
        `
        INSERT INTO positions (id, symbol, name, address, chain, tier, entry_price, current_price,
          quantity, value_usd, percent_of_portfolio, entry_date, stop_loss, take_profit_levels,
          narrative, status, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        p.id,
        p.symbol,
        p.name,
        p.address,
        p.chain,
        p.tier,
        p.entry_price,
        p.current_price,
        p.quantity,
        p.value_usd,
        p.percent_of_portfolio,
        p.entry_date || new Date().toISOString().split('T')[0],
        p.stop_loss,
        JSON.stringify(p.take_profit_levels),
        p.narrative,
        p.status || 'open',
        p.notes,
      );
      output({ ok: true, id: p.id });
      break;
    }
    case 'update-position': {
      const id = getArg('id');
      const updates = parseJson();
      if (!id) error('Missing --id');
      const fields = Object.keys(updates);
      const setClauses = fields.map((f) => (f === 'take_profit_levels' ? `${f} = ?` : `${f} = ?`)).join(', ');
      const values = fields.map((f) => (f === 'take_profit_levels' ? JSON.stringify(updates[f]) : updates[f]));
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
    case 'close-position': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      const updates = parseJson();
      const position = db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
      if (!position) error(`Position not found: ${id}`);
      const exitPrice = updates.exit_price;
      if (exitPrice === undefined || exitPrice === null) error('Missing exit_price in --json');
      const soldQty = getArg('quantity');
      if (soldQty !== null) {
        // Partial exit
        const qty = parseFloat(soldQty);
        if (isNaN(qty) || qty <= 0) error('Invalid --quantity');
        if (qty > position.quantity) error(`Sold quantity ${qty} exceeds position quantity ${position.quantity}`);
        const pnlPercent = ((exitPrice - position.entry_price) / position.entry_price) * 100;
        const pnlUsd = (exitPrice - position.entry_price) * qty;
        const prevPnl = position.pnl_usd || 0;
        const newQty = position.quantity - qty;
        db.prepare(
          `
          UPDATE positions SET quantity = ?, status = 'partial_exit',
            pnl_percent = ?, pnl_usd = ?, exit_reason = ?, updated_at = datetime('now')
          WHERE id = ?
        `,
        ).run(
          newQty,
          Math.round(pnlPercent * 100) / 100,
          Math.round((prevPnl + pnlUsd) * 100) / 100,
          updates.exit_reason || null,
          id,
        );
        output({
          ok: true,
          id,
          pnl_percent: Math.round(pnlPercent * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
        });
      } else {
        // Full exit
        const pnlPercent = ((exitPrice - position.entry_price) / position.entry_price) * 100;
        const pnlUsd = (exitPrice - position.entry_price) * position.quantity;
        db.prepare(
          `
          UPDATE positions SET status = 'closed', exit_price = ?, exit_date = date('now'),
            pnl_percent = ?, pnl_usd = ?, exit_reason = ?, updated_at = datetime('now')
          WHERE id = ?
        `,
        ).run(
          exitPrice,
          Math.round(pnlPercent * 100) / 100,
          Math.round(pnlUsd * 100) / 100,
          updates.exit_reason || null,
          id,
        );
        output({
          ok: true,
          id,
          pnl_percent: Math.round(pnlPercent * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
        });
      }
      break;
    }

    // ============================================================
    // Portfolio
    // ============================================================
    case 'get-portfolio': {
      const chain = getArg('chain');
      const safeId = db.prepare("SELECT value FROM portfolio_meta WHERE key = 'safe_id'").get()?.value;
      if (chain) {
        const positions = db
          .prepare(
            "SELECT * FROM positions WHERE chain = ? AND status IN ('open', 'partial_exit') ORDER BY created_at DESC",
          )
          .all(chain)
          .map((r) => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) }));
        const cash = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(cashKey(chain))?.value || '0',
        );
        const totalDeposited = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`total_deposited_${chain}`)?.value || '0',
        );
        const positionValue = positions.reduce((sum, p) => sum + (p.current_price || p.entry_price) * p.quantity, 0);
        output({
          safe_id: safeId,
          chain,
          cash,
          total_deposited: totalDeposited,
          positions,
          total_value: Math.round((cash + positionValue) * 100) / 100,
        });
      } else {
        const allPositions = db
          .prepare("SELECT * FROM positions WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC")
          .all()
          .map((r) => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) }));
        const cashBreakdown = getAllCashBreakdown(db);
        const chains = {};
        for (const c of getAllChains()) {
          const cPositions = allPositions.filter((p) => p.chain === c);
          const cCash = cashBreakdown[c] || 0;
          const positionValue = cPositions.reduce((sum, p) => sum + (p.current_price || p.entry_price) * p.quantity, 0);
          chains[c] = {
            cash: cCash,
            positions: cPositions,
            total_value: Math.round((cCash + positionValue) * 100) / 100,
          };
        }
        const totalValue = Object.values(chains).reduce((sum, c) => sum + c.total_value, 0);
        output({ safe_id: safeId, chains, total_value: Math.round(totalValue * 100) / 100 });
      }
      break;
    }
    case 'get-cash': {
      const chain = getArg('chain');
      if (chain) {
        const cash = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(cashKey(chain))?.value || '0',
        );
        output({ chain, cash });
      } else {
        output(getAllCashBreakdown(db));
      }
      break;
    }
    case 'set-cash': {
      const amount = getArg('amount');
      const chain = getArg('chain');
      if (amount === null) error('Missing --amount');
      if (!chain) error('Missing --chain (required for set-cash)');
      const key = cashKey(chain);
      db.prepare(
        "INSERT INTO portfolio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      ).run(key, String(amount), String(amount));
      output({ ok: true, chain, cash: parseFloat(amount) });
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
      db.prepare(
        `
        INSERT INTO portfolio_meta (key, value) VALUES (?, ?)
        ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')
      `,
      ).run(key, value, value);
      output({ ok: true, key, value });
      break;
    }

    // ============================================================
    // Approved trades
    // ============================================================
    case 'get-orders': {
      const pending = hasFlag('pending');
      const action = getArg('action');
      const approved = hasFlag('approved');
      const conditions = [];
      const params = [];
      if (pending) conditions.push('executed = 0');
      if (action) {
        conditions.push('action = ?');
        params.push(action);
      }
      if (approved) conditions.push('approved = 1');
      const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : '';
      const order = pending ? ' ORDER BY created_at ASC' : ' ORDER BY created_at DESC';
      const sql = `SELECT * FROM orders${where}${order}`;
      const rows = db.prepare(sql).all(...params);
      output(
        rows.map((r) => (r.take_profit_levels ? { ...r, take_profit_levels: JSON.parse(r.take_profit_levels) } : r)),
      );
      break;
    }
    case 'add-order': {
      const t = parseJson();
      if (!t.action || !['buy', 'sell'].includes(t.action)) error('add-order requires "action": "buy" or "sell"');
      if (t.action === 'buy') {
        if (
          !t.symbol ||
          !t.address ||
          !t.chain ||
          t.amount == null ||
          !t.tier ||
          t.entry_price == null ||
          t.stop_loss == null ||
          !t.take_profit_levels
        )
          error('Buy order requires: symbol, address, chain, amount, tier, entry_price, stop_loss, take_profit_levels');
      } else {
        if (!t.symbol || !t.address || !t.chain || t.amount == null || !t.reason)
          error('Sell order requires: symbol, address, chain, amount, reason');
      }
      const isSell = t.action === 'sell';
      db.prepare(
        `
        INSERT INTO orders (id, action, symbol, name, address, chain, amount,
          percent_of_portfolio, tier, entry_price, stop_loss, take_profit_levels,
          analysis_score, risk_score, reasoning, reason, urgency,
          approved, approved_at, approved_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        t.id,
        t.action,
        t.symbol,
        t.name || null,
        t.address,
        t.chain,
        String(t.amount),
        t.percent_of_portfolio || null,
        t.tier || null,
        t.entry_price || null,
        t.stop_loss || null,
        t.take_profit_levels ? JSON.stringify(t.take_profit_levels) : null,
        t.analysis_score || null,
        t.risk_score || null,
        t.reasoning || null,
        t.reason || null,
        t.urgency || (isSell ? 'immediate' : null),
        isSell ? 1 : t.approved ? 1 : 0,
        isSell ? new Date().toISOString() : t.approved_at || null,
        isSell ? 'sentinel' : t.approved_by || 'human',
      );
      output({ ok: true, id: t.id });
      break;
    }
    case 'mark-order-executed': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      db.prepare("UPDATE orders SET executed = 1, executed_at = datetime('now') WHERE id = ?").run(id);
      output({ ok: true, id });
      break;
    }

    // ============================================================
    // Receipts
    // ============================================================
    case 'add-receipt': {
      const r = parseJson();
      db.prepare(
        `
        INSERT INTO receipts (id, order_id, action, symbol, address, chain,
          amount, quantity, expected_price, executed_price, slippage, status, safe_tx_hash,
          onchain_tx_hash, safe_nonce, signatures_collected, signatures_required, gas_used, error, notes)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        r.id,
        r.order_id,
        r.action,
        r.symbol,
        r.address,
        r.chain,
        r.amount,
        r.quantity,
        r.expected_price,
        r.executed_price,
        r.slippage,
        r.status,
        r.safe_tx_hash,
        r.onchain_tx_hash,
        r.safe_nonce,
        r.signatures_collected,
        r.signatures_required,
        r.gas_used,
        r.error,
        r.notes,
      );
      output({ ok: true, id: r.id });
      break;
    }
    case 'get-receipts': {
      const status = getArg('status');
      const limit = parseInt(getArg('limit') || '50');
      const rows = status
        ? db.prepare('SELECT * FROM receipts WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit)
        : db.prepare('SELECT * FROM receipts ORDER BY created_at DESC LIMIT ?').all(limit);
      output(rows);
      break;
    }
    case 'get-receipt': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      const row = db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
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
      db.prepare(
        `
        INSERT INTO sentinel_alerts (id, symbol, chain, alert_type, severity, current_price,
          trigger_price, details, action, sell_amount)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        a.id,
        a.symbol,
        a.chain,
        a.alert_type,
        a.severity,
        a.current_price,
        a.trigger_price,
        a.details,
        a.action,
        a.sell_amount,
      );
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
      db.prepare(
        `
        INSERT INTO watchlist (id, symbol, address, chain, target_entry, current_price,
          analysis_score, risk_score, narrative, reason, expires_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        w.id,
        w.symbol,
        w.address,
        w.chain,
        w.target_entry,
        w.current_price,
        w.analysis_score,
        w.risk_score,
        w.narrative,
        w.reason,
        w.expires_at,
        w.status || 'watching',
      );
      output({ ok: true, id: w.id });
      break;
    }
    case 'update-watchlist': {
      const id = getArg('id');
      const updates = parseJson();
      if (!id) error('Missing --id');
      const fields = Object.keys(updates);
      const setClauses = fields.map((f) => `${f} = ?`).join(', ');
      const values = fields.map((f) => updates[f]);
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
      const rows = db
        .prepare('SELECT * FROM liquidity_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT ?')
        .all(address, chain, limit);
      output(rows);
      break;
    }
    case 'add-liquidity-snapshot': {
      const address = getArg('address');
      const chain = getArg('chain');
      const liquidity = getArg('liquidity');
      if (!address || !chain || liquidity === null) error('Missing --address, --chain, or --liquidity');
      db.prepare('INSERT INTO liquidity_snapshots (address, chain, liquidity_usd) VALUES (?, ?, ?)').run(
        address,
        chain,
        parseFloat(liquidity),
      );
      output({ ok: true });
      break;
    }

    // ============================================================
    // Contract Snapshots
    // ============================================================
    case 'get-contract-snapshots': {
      const address = getArg('address');
      const chain = getArg('chain');
      const limit = parseInt(getArg('limit') || '5');
      if (!address || !chain) error('Missing --address or --chain');
      const rows = db
        .prepare('SELECT * FROM contract_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT ?')
        .all(address, chain, limit);
      output(rows);
      break;
    }
    case 'add-contract-snapshot': {
      const address = getArg('address');
      const chain = getArg('chain');
      const json = getArg('json');
      if (!address || !chain || !json) error('Missing --address, --chain, or --json');
      db.prepare('INSERT INTO contract_snapshots (address, chain, safety_data) VALUES (?, ?, ?)').run(
        address,
        chain,
        json,
      );
      output({ ok: true });
      break;
    }

    // ============================================================
    // Tracked wallets
    // ============================================================
    case 'get-tracked-wallets': {
      const status = getArg('status');
      const rows = status
        ? db.prepare('SELECT * FROM tracked_wallets WHERE status = ? ORDER BY created_at DESC').all(status)
        : db.prepare('SELECT * FROM tracked_wallets ORDER BY created_at DESC').all();
      output(rows);
      break;
    }
    case 'add-tracked-wallet': {
      const w = parseJson();
      const walletStatus = w.type ? 'scored' : 'proposed';
      db.prepare(
        `
        INSERT OR REPLACE INTO tracked_wallets (address, chain, label, type, notes, status, score, score_breakdown, source_token)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        w.address,
        w.chain,
        w.label,
        w.type,
        w.notes,
        w.status || walletStatus,
        w.score || null,
        w.score_breakdown ? JSON.stringify(w.score_breakdown) : null,
        w.source_token || null,
      );
      output({ ok: true, address: w.address });
      break;
    }
    case 'propose-wallet': {
      const w = parseJson();
      if (!w.address || !w.chain) error('Missing address or chain');
      const source = getArg('source') || w.source || 'agent';
      db.prepare(
        `
        INSERT OR IGNORE INTO tracked_wallets (address, chain, label, source_token, source, status)
        VALUES (?, ?, ?, ?, ?, 'proposed')
      `,
      ).run(w.address, w.chain, w.label || null, w.source_token || null, source);
      output({ ok: true, address: w.address, status: 'proposed', source });
      break;
    }
    case 'get-unscored-wallets': {
      const limit = parseInt(getArg('limit') || '5');
      const rows = db
        .prepare(
          `
        SELECT * FROM tracked_wallets
        WHERE status = 'proposed' OR (status = 'failed' AND retry_count < 3)
        ORDER BY created_at ASC
        LIMIT ?
      `,
        )
        .all(limit);
      output(rows);
      break;
    }
    case 'update-wallet-score': {
      const address = getArg('address');
      const chain = getArg('chain');
      const data = parseJson();
      if (!address || !chain) error('Missing --address or --chain');
      db.prepare(
        `
        UPDATE tracked_wallets
        SET score = ?, type = ?, score_breakdown = ?, status = ?,
            scored_at = datetime('now'), score_error = ?, retry_count = CASE WHEN ? = 'failed' THEN retry_count + 1 ELSE retry_count END
        WHERE address = ? AND chain = ?
      `,
      ).run(
        data.score || null,
        data.type || null,
        data.score_breakdown
          ? typeof data.score_breakdown === 'string'
            ? data.score_breakdown
            : JSON.stringify(data.score_breakdown)
          : null,
        data.status || 'scored',
        data.score_error || null,
        data.status || 'scored',
        address,
        chain,
      );
      output({ ok: true, address, chain, status: data.status || 'scored' });
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
      db.prepare("UPDATE heartbeat_state SET last_run = datetime('now') WHERE agent = ? AND check_type = ?").run(
        agent,
        check,
      );
      output({ ok: true });
      break;
    }

    // ============================================================
    // Logs
    // ============================================================
    case 'add-sentinel-log': {
      const l = parseJson();
      db.prepare(
        `
        INSERT INTO sentinel_log (check_type, positions_checked, alerts_generated, sells_executed, status)
        VALUES (?, ?, ?, ?, ?)
      `,
      ).run(l.check_type, l.positions_checked || 0, l.alerts_generated || 0, l.sells_executed || 0, l.status || 'ok');
      output({ ok: true });
      break;
    }
    case 'add-executor-log': {
      const l = parseJson();
      db.prepare(
        `
        INSERT INTO executor_log (sell_orders_processed, buy_orders_processed, pending_checked,
          success_count, fail_count, queued_count, status)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        l.sell_orders_processed || 0,
        l.buy_orders_processed || 0,
        l.pending_checked || 0,
        l.success_count || 0,
        l.fail_count || 0,
        l.queued_count || 0,
        l.status || 'ok',
      );
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
      db.prepare(
        `
        INSERT INTO trades (id, symbol, address, chain, tier, action, entry_price, exit_price,
          quantity, entry_date, exit_date, pnl_percent, pnl_usd, exit_reason, analysis_score,
          risk_score, narrative, lesson, duration_days)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        t.id,
        t.symbol,
        t.address,
        t.chain,
        t.tier,
        t.action,
        t.entry_price,
        t.exit_price,
        t.quantity,
        t.entry_date,
        t.exit_date,
        t.pnl_percent,
        t.pnl_usd,
        t.exit_reason,
        t.analysis_score,
        t.risk_score,
        t.narrative,
        t.lesson,
        t.duration_days,
      );
      output({ ok: true, id: t.id });
      break;
    }
    case 'get-trades': {
      const limit = parseInt(getArg('limit') || '50');
      output(db.prepare('SELECT * FROM trades ORDER BY created_at DESC LIMIT ?').all(limit));
      break;
    }
    case 'get-trade-stats': {
      const stats = db
        .prepare(
          `
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
      `,
        )
        .get();
      stats.win_rate = stats.total_trades > 0 ? Math.round((stats.wins / stats.total_trades) * 100) : 0;
      output(stats);
      break;
    }

    // ============================================================
    // Paper Mode
    // ============================================================
    case 'add-paper-receipt': {
      const t = parseJson();
      if (!t.quantity || t.quantity <= 0)
        error('Paper receipt requires quantity > 0 (use add-receipt for failed trades)');
      db.prepare(
        `
        INSERT INTO paper_receipts (id, order_id, action, symbol, address, chain,
          tier, proposed_price, quantity, amount, stop_loss, take_profit_levels, reasoning,
          pnl_percent, pnl_usd)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      ).run(
        t.id,
        t.order_id,
        t.action,
        t.symbol,
        t.address,
        t.chain,
        t.tier,
        t.proposed_price,
        t.quantity,
        t.amount,
        t.stop_loss,
        t.take_profit_levels ? JSON.stringify(t.take_profit_levels) : null,
        t.reasoning,
        t.pnl_percent,
        t.pnl_usd,
      );
      output({ ok: true, id: t.id });
      break;
    }
    case 'get-paper-receipts': {
      const limit = parseInt(getArg('limit') || '50');
      output(db.prepare('SELECT * FROM paper_receipts ORDER BY created_at DESC LIMIT ?').all(limit));
      break;
    }
    case 'get-paper-positions': {
      const status = getArg('status') || 'open';
      const symbol = getArg('symbol');
      let rows;
      if (symbol) {
        rows =
          status === 'all'
            ? db.prepare('SELECT * FROM paper_positions WHERE symbol = ? ORDER BY created_at DESC').all(symbol)
            : db
                .prepare('SELECT * FROM paper_positions WHERE status = ? AND symbol = ? ORDER BY created_at DESC')
                .all(status, symbol);
      } else {
        rows =
          status === 'all'
            ? db.prepare('SELECT * FROM paper_positions ORDER BY created_at DESC').all()
            : db.prepare('SELECT * FROM paper_positions WHERE status = ? ORDER BY created_at DESC').all(status);
      }
      output(rows.map((r) => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) })));
      break;
    }
    case 'add-paper-position': {
      const p = parseJson();
      const valueUsd = p.value_usd || p.amount_usd;
      const qty = valueUsd && p.entry_price ? valueUsd / p.entry_price : p.quantity;
      const cost = valueUsd || p.entry_price * qty;
      const posChain = p.chain || 'base';
      const pcKey = cashKey(posChain, true);
      const currentCash = parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(pcKey)?.value || '0',
      );
      const newCash = Math.round((currentCash - cost) * 100) / 100;
      const txn = db.transaction(() => {
        db.prepare(
          `
          INSERT INTO paper_positions (id, symbol, address, chain, tier, entry_price, current_price,
            quantity, value_usd, entry_date, stop_loss, take_profit_levels, status)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        ).run(
          p.id,
          p.symbol,
          p.address,
          posChain,
          p.tier,
          p.entry_price,
          p.current_price,
          qty,
          valueUsd || null,
          p.entry_date || new Date().toISOString().split('T')[0],
          p.stop_loss,
          JSON.stringify(p.take_profit_levels),
          p.status || 'open',
        );
        db.prepare(
          "INSERT INTO portfolio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
        ).run(pcKey, String(newCash), String(newCash));
      });
      txn();
      output({ ok: true, id: p.id, chain: posChain, cash: newCash });
      break;
    }
    case 'update-paper-position': {
      const id = getArg('id');
      const updates = parseJson();
      if (!id) error('Missing --id');
      const fields = Object.keys(updates);
      const setClauses = fields.map((f) => `${f} = ?`).join(', ');
      const values = fields.map((f) => (f === 'take_profit_levels' ? JSON.stringify(updates[f]) : updates[f]));
      db.prepare(`UPDATE paper_positions SET ${setClauses}, updated_at = datetime('now') WHERE id = ?`).run(
        ...values,
        id,
      );
      output({ ok: true, id });
      break;
    }
    case 'close-paper-position': {
      const id = getArg('id');
      if (!id) error('Missing --id');
      const updates = parseJson();
      const position = db.prepare('SELECT * FROM paper_positions WHERE id = ?').get(id);
      if (!position) error(`Paper position not found: ${id}`);
      const exitPrice = updates.exit_price;
      if (exitPrice === undefined || exitPrice === null) error('Missing exit_price in --json');
      const posChain = position.chain || 'base';
      const pcKey = cashKey(posChain, true);
      const currentCash = parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(pcKey)?.value || '0',
      );
      const soldQty = getArg('quantity');
      if (soldQty !== null) {
        // Partial exit
        const qty = parseFloat(soldQty);
        if (isNaN(qty) || qty <= 0) error('Invalid --quantity');
        if (qty > position.quantity) error(`Sold quantity ${qty} exceeds position quantity ${position.quantity}`);
        const pnlPercent = ((exitPrice - position.entry_price) / position.entry_price) * 100;
        const pnlUsd = (exitPrice - position.entry_price) * qty;
        const prevPnl = position.pnl_usd || 0;
        const newQty = position.quantity - qty;
        const saleProceeds = exitPrice * qty;
        const newCash = Math.round((currentCash + saleProceeds) * 100) / 100;
        const txn = db.transaction(() => {
          db.prepare(
            `
            UPDATE paper_positions SET quantity = ?, status = 'partial_exit',
              pnl_percent = ?, pnl_usd = ?, exit_reason = ?, updated_at = datetime('now')
            WHERE id = ?
          `,
          ).run(
            newQty,
            Math.round(pnlPercent * 100) / 100,
            Math.round((prevPnl + pnlUsd) * 100) / 100,
            updates.exit_reason || null,
            id,
          );
          db.prepare(
            "INSERT INTO portfolio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          ).run(pcKey, String(newCash), String(newCash));
        });
        txn();
        output({
          ok: true,
          id,
          chain: posChain,
          pnl_percent: Math.round(pnlPercent * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
          remaining_quantity: newQty,
          cash: newCash,
        });
      } else {
        // Full exit
        const pnlPercent = ((exitPrice - position.entry_price) / position.entry_price) * 100;
        const pnlUsd = (exitPrice - position.entry_price) * position.quantity;
        const saleProceeds = exitPrice * position.quantity;
        const newCash = Math.round((currentCash + saleProceeds) * 100) / 100;
        const txn = db.transaction(() => {
          db.prepare(
            `
            UPDATE paper_positions SET status = 'closed', exit_price = ?, exit_date = date('now'),
              pnl_percent = ?, pnl_usd = ?, exit_reason = ?, updated_at = datetime('now')
            WHERE id = ?
          `,
          ).run(
            exitPrice,
            Math.round(pnlPercent * 100) / 100,
            Math.round(pnlUsd * 100) / 100,
            updates.exit_reason || null,
            id,
          );
          db.prepare(
            "INSERT INTO portfolio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
          ).run(pcKey, String(newCash), String(newCash));
        });
        txn();
        output({
          ok: true,
          id,
          chain: posChain,
          pnl_percent: Math.round(pnlPercent * 100) / 100,
          pnl_usd: Math.round(pnlUsd * 100) / 100,
          cash: newCash,
        });
      }
      break;
    }
    case 'get-paper-portfolio': {
      const chain = getArg('chain');
      const chainFilter = chain ? 'AND chain = ?' : '';
      const chainArgs = chain ? [chain] : [];

      const initialBalanceKey = chain ? `paper_initial_balance_${chain}` : 'paper_initial_balance';
      const initialBalance = parseFloat(
        db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(initialBalanceKey)?.value || '10000',
      );

      const closedPnl = db
        .prepare(
          `SELECT COALESCE(SUM(pnl_usd), 0) as total, COUNT(*) as count FROM paper_positions WHERE status = 'closed' AND pnl_usd IS NOT NULL ${chainFilter}`,
        )
        .get(...chainArgs);
      const partialPnl = db
        .prepare(
          `
        SELECT COALESCE(SUM(pnl_usd), 0) as total, COUNT(*) as count FROM paper_receipts
        WHERE action = 'sell' AND pnl_usd IS NOT NULL
        AND address IN (SELECT address FROM paper_positions WHERE status IN ('open', 'partial_exit') ${chainFilter})
      `,
        )
        .get(...chainArgs);
      const realizedPnl = closedPnl.total + partialPnl.total;
      const realizedCount = closedPnl.count + partialPnl.count;

      const positions = db
        .prepare(
          `SELECT * FROM paper_positions WHERE status IN ('open', 'partial_exit') ${chainFilter} ORDER BY created_at DESC`,
        )
        .all(...chainArgs)
        .map((r) => ({ ...r, take_profit_levels: JSON.parse(r.take_profit_levels) }));

      let cash;
      if (chain) {
        cash = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(cashKey(chain, true))?.value || '0',
        );
      } else {
        const breakdown = getAllCashBreakdown(db, true);
        cash = breakdown.total;
      }

      const positionValue = positions.reduce((sum, p) => sum + (p.current_price || p.entry_price) * p.quantity, 0);
      const totalValue = Math.round((cash + positionValue) * 100) / 100;
      const pnl = Math.round((totalValue - initialBalance) * 100) / 100;
      const pnlPercent =
        initialBalance > 0 ? Math.round(((totalValue - initialBalance) / initialBalance) * 10000) / 100 : 0;

      const closedPositions = db
        .prepare(
          `SELECT id, symbol, chain, tier, entry_price, exit_price, pnl_percent, pnl_usd, exit_reason, exit_date FROM paper_positions WHERE status = 'closed' ${chainFilter} ORDER BY exit_date DESC LIMIT 20`,
        )
        .all(...chainArgs);
      const recentTrades = db
        .prepare(`SELECT * FROM paper_receipts WHERE quantity > 0 ${chainFilter} ORDER BY created_at DESC LIMIT 10`)
        .all(...chainArgs);

      const result = {
        cash,
        initial_balance: initialBalance,
        total_value: totalValue,
        pnl,
        pnl_percent: pnlPercent,
        realized_pnl: Math.round(realizedPnl * 100) / 100,
        total_closed_trades: realizedCount,
        positions,
        closed_positions: closedPositions,
        recent_trades: recentTrades,
      };
      if (chain) result.chain = chain;
      output(result);
      break;
    }
    case 'get-paper-cash': {
      const chain = getArg('chain');
      if (chain) {
        const cash = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(cashKey(chain, true))?.value || '0',
        );
        output({ chain, cash });
      } else {
        output(getAllCashBreakdown(db, true));
      }
      break;
    }
    case 'set-paper-cash': {
      const amount = getArg('amount');
      const chain = getArg('chain');
      if (amount === null) error('Missing --amount');
      if (!chain) error('Missing --chain (required for set-paper-cash)');
      const key = cashKey(chain, true);
      db.prepare(
        "INSERT INTO portfolio_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      ).run(key, String(amount), String(amount));
      output({ ok: true, chain, cash: parseFloat(amount) });
      break;
    }
    case 'get-paper-stats': {
      const chain = getArg('chain');
      const chainFilter = chain ? 'AND chain = ?' : '';
      const chainArgs = chain ? [chain] : [];
      const stats = db
        .prepare(
          `
        SELECT
          COUNT(*) as total_trades,
          SUM(CASE WHEN pnl_usd > 0 THEN 1 ELSE 0 END) as wins,
          SUM(CASE WHEN pnl_usd <= 0 THEN 1 ELSE 0 END) as losses,
          ROUND(AVG(CASE WHEN pnl_usd > 0 THEN pnl_percent END), 2) as avg_win_percent,
          ROUND(AVG(CASE WHEN pnl_usd <= 0 THEN pnl_percent END), 2) as avg_loss_percent,
          ROUND(SUM(pnl_usd), 2) as total_pnl_usd,
          MAX(pnl_usd) as best_trade_pnl,
          MIN(pnl_usd) as worst_trade_pnl
        FROM paper_receipts WHERE pnl_usd IS NOT NULL ${chainFilter}
      `,
        )
        .get(...chainArgs);
      let cash, initialBalance;
      if (chain) {
        cash = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(cashKey(chain, true))?.value || '0',
        );
        initialBalance = parseFloat(
          db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`paper_initial_balance_${chain}`)?.value ||
            '0',
        );
      } else {
        cash = getAllCashBreakdown(db, true).total;
        initialBalance = parseFloat(
          db.prepare("SELECT value FROM portfolio_meta WHERE key = 'paper_initial_balance'").get()?.value || '10000',
        );
      }
      const openPositions = db
        .prepare(`SELECT * FROM paper_positions WHERE status IN ('open', 'partial_exit') ${chainFilter}`)
        .all(...chainArgs);
      const positionValue = openPositions.reduce(
        (sum, p) => sum + (p.value_usd || (p.current_price || p.entry_price) * p.quantity),
        0,
      );
      const totalValue = cash + positionValue;
      stats.win_rate = stats.total_trades > 0 ? Math.round((stats.wins / stats.total_trades) * 100) : 0;
      stats.total_return_percent =
        initialBalance > 0 ? Math.round(((totalValue - initialBalance) / initialBalance) * 10000) / 100 : 0;
      stats.current_value = totalValue;
      stats.initial_balance = initialBalance;
      if (chain) stats.chain = chain;
      output(stats);
      break;
    }

    // ============================================================
    // Analysis Cache (dedup)
    // ============================================================
    case 'check-token-status': {
      const address = getArg('address');
      const chain = getArg('chain');
      if (!address || !chain) error('Missing --address or --chain');
      const isPaper = process.env.PAPER_MODE === 'true';

      // 1. Open positions (or paper_positions)
      const posTable = isPaper ? 'paper_positions' : 'positions';
      const pos = db
        .prepare(
          `SELECT id, symbol, status FROM ${posTable} WHERE address = ? AND chain = ? AND status IN ('open', 'partial_exit')`,
        )
        .get(address, chain);
      if (pos) {
        output({
          address,
          chain,
          action: 'skip',
          reason: 'open_position',
          details: { id: pos.id, symbol: pos.symbol, status: pos.status },
        });
        break;
      }

      // 2. Pending orders (buy or sell, not yet executed)
      const pendingOrder = db
        .prepare('SELECT id, symbol, action FROM orders WHERE address = ? AND chain = ? AND executed = 0')
        .get(address, chain);
      if (pendingOrder) {
        const reason = pendingOrder.action === 'buy' ? 'pending_buy' : 'pending_sell';
        output({
          address,
          chain,
          action: 'skip',
          reason,
          details: { id: pendingOrder.id, symbol: pendingOrder.symbol },
        });
        break;
      }

      // 4. Active watchlist
      const watched = db
        .prepare("SELECT id, symbol FROM watchlist WHERE address = ? AND chain = ? AND status = 'watching'")
        .get(address, chain);
      if (watched) {
        output({
          address,
          chain,
          action: 'skip',
          reason: 'on_watchlist',
          details: { id: watched.id, symbol: watched.symbol },
        });
        break;
      }

      // 5. Unexpired analysis cache
      const cached = db
        .prepare(
          "SELECT symbol, verdict, analysis_score, risk_score, reasoning, expires_at FROM analysis_cache WHERE address = ? AND chain = ? AND expires_at > datetime('now')",
        )
        .get(address, chain);
      if (cached) {
        output({ address, chain, action: 'skip', reason: 'cached_analysis', details: cached });
        break;
      }

      // 6. Nothing found — proceed with analysis
      output({ address, chain, action: 'analyze', reason: 'none' });
      break;
    }
    case 'cache-analysis': {
      const c = parseJson();
      if (!c.address || !c.chain || !c.verdict) error('Missing required fields: address, chain, verdict');
      const ttlHours = c.ttl_hours || 24;
      db.prepare(
        `
        INSERT INTO analysis_cache (address, chain, symbol, analysis_score, risk_score, verdict, tier, reasoning, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now', '+' || ? || ' hours'))
        ON CONFLICT(address, chain) DO UPDATE SET
          symbol = excluded.symbol, analysis_score = excluded.analysis_score,
          risk_score = excluded.risk_score, verdict = excluded.verdict,
          tier = excluded.tier, reasoning = excluded.reasoning,
          expires_at = excluded.expires_at, created_at = datetime('now')
      `,
      ).run(
        c.address,
        c.chain,
        c.symbol || null,
        c.analysis_score || null,
        c.risk_score || null,
        c.verdict,
        c.tier || null,
        c.reasoning || null,
        ttlHours,
      );
      output({ ok: true, address: c.address, chain: c.chain, verdict: c.verdict, ttl_hours: ttlHours });
      break;
    }
    case 'get-analysis-cache': {
      const rows = db
        .prepare("SELECT * FROM analysis_cache WHERE expires_at > datetime('now') ORDER BY created_at DESC")
        .all();
      output(rows);
      break;
    }
    case 'clear-expired-cache': {
      const result = db.prepare("DELETE FROM analysis_cache WHERE expires_at <= datetime('now')").run();
      output({ ok: true, deleted: result.changes });
      break;
    }

    // ============================================================
    // Portfolio Sync (On-Chain)
    // ============================================================
    case 'sync-portfolio': {
      const chain = getArg('chain');
      if (!chain) error('Missing --chain');
      const trigger = getArg('trigger') || 'manual';

      // Fork to the appropriate loader script
      const isPaper = process.env.PAPER_MODE === 'true';
      if (isPaper) {
        output({ ok: false, message: 'Portfolio sync skipped in paper mode — DB is sole source of truth' });
        break;
      }

      try {
        const scriptDir = new URL('.', import.meta.url).pathname;
        const script = isSolana(chain) ? 'portfolio-load-solana.js' : 'portfolio-load-evm.js';
        const result = execSync(`node ${scriptDir}${script} --chain ${chain} --trigger ${trigger}`, {
          encoding: 'utf-8',
          timeout: 60_000,
        });
        output(JSON.parse(result));
      } catch (e) {
        error(`Sync failed: ${e.message}`);
      }
      break;
    }
    case 'get-sync-status': {
      const chain = getArg('chain');
      if (chain) {
        const rows = db
          .prepare('SELECT * FROM portfolio_sync WHERE chain = ? ORDER BY synced_at DESC LIMIT 5')
          .all(chain);
        output(rows);
      } else {
        const rows = db.prepare('SELECT * FROM portfolio_sync ORDER BY synced_at DESC LIMIT 20').all();
        output(rows);
      }
      break;
    }
    case 'set-onchain-balance': {
      const id = getArg('id');
      const balance = getArg('balance');
      if (!id || balance === null) error('Missing --id or --balance');
      db.prepare(
        "UPDATE positions SET onchain_balance = ?, last_synced_at = datetime('now'), updated_at = datetime('now') WHERE id = ?",
      ).run(parseFloat(balance), id);
      output({ ok: true, id, onchain_balance: parseFloat(balance) });
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
