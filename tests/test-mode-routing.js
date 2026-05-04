#!/usr/bin/env node
/**
 * Test Suite: Mode Routing (Phase 0)
 *
 * Verifies the PAPER_MODE auto-routing in db-query.js:
 *   - Unified read commands (get-portfolio, get-positions, get-cash, get-receipts)
 *     route to paper_* tables when PAPER_MODE=true.
 *   - Unified write commands (set-cash, update-position, close-position, add-receipt)
 *     route to paper_* tables when PAPER_MODE=true.
 *   - The paper-* names continue to work as silent aliases (backward compat).
 *   - Object responses carry an _mode envelope so a forgotten env var is visible.
 *   - Commands that intentionally do NOT auto-route (add-position, get-paper-stats)
 *     keep their explicit shape.
 *
 * Uses a unique SAFE_ID so it doesn't collide with real data or other test runs.
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { unlinkSync, existsSync } from 'fs';
import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

const PROJECT_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const DB_QUERY = resolve(PROJECT_ROOT, 'scripts/db-query.js');
const SAFE_ID = `mode-routing-${Date.now()}`;

function dbq(command, paper = false) {
  // Explicit PAPER_MODE='false' is required: dotenv loads .env which may set
  // PAPER_MODE=true, and dotenv defaults to NOT overriding an existing env
  // var — but `delete env.PAPER_MODE` removes ours, leaving dotenv to inject
  // the .env value. Setting 'false' explicitly wins against dotenv.
  const env = { ...process.env, SAFE_ID, PAPER_MODE: paper ? 'true' : 'false' };
  const out = execSync(`node ${DB_QUERY} ${command}`, {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    env,
    timeout: 10_000,
  }).trim();
  const lines = out.split('\n');
  const jsonStart = lines.findIndex((l) => l.startsWith('{') || l.startsWith('['));
  return JSON.parse(lines.slice(jsonStart).join('\n'));
}

describe('Mode Routing — Setup', () => {
  test('migrations succeed', () => {
    const r = dbq('migrate', true);
    assert(r.ok, 'migrate must return ok');
  });

  test('seed paper cash and a paper position on base', () => {
    dbq('set-paper-cash --chain base --amount 10000', true);
    dbq(
      `add-paper-position --json '${JSON.stringify({
        id: 'mr-pos-1',
        symbol: 'MRT',
        address: '0xmr1',
        chain: 'base',
        tier: 'moonshot',
        entry_price: 0.001,
        value_usd: 100,
        stop_loss: 0.0005,
        take_profit_levels: [{ level: 1, price: 0.002, sellPercent: 50 }],
        status: 'open',
      })}'`,
      true,
    );
    const positions = dbq('get-paper-positions --status open', true);
    assertEqual(positions.length, 1, 'paper_positions must hold the seeded row');
  });

  test('seed real cash on base (no real positions)', () => {
    // Real-mode write: set-cash routes to cash_base when PAPER_MODE is unset.
    dbq('set-cash --chain base --amount 5000', false);
    const real = dbq('get-cash --chain base', false);
    assertEqual(real.cash, 5000, 'real cash_base must be 5000');
    assertEqual(real._mode, 'real', '_mode envelope must read "real" without PAPER_MODE');
  });
});

describe('Mode Routing — Reads auto-route under PAPER_MODE', () => {
  test('get-positions routes to paper_positions when PAPER_MODE=true', () => {
    const routed = dbq('get-positions --status open', true);
    assertEqual(routed.length, 1, 'auto-routed get-positions must see the paper position');
    assertEqual(routed[0].symbol, 'MRT', 'must be the paper position');
  });

  test('get-positions returns empty real_positions when PAPER_MODE is unset', () => {
    const real = dbq('get-positions --status open', false);
    assertEqual(real.length, 0, 'real positions must be empty (never written)');
  });

  test('get-cash routes to paper_cash_base when PAPER_MODE=true', () => {
    // paper_cash_base was seeded to 10000 then debited 100 by add-paper-position.
    // The real cash_base was set to 5000. If routing failed, we'd see 5000.
    const routed = dbq('get-cash --chain base', true);
    assertEqual(routed.cash, 9900, 'must read paper_cash_base (10000 - 100 from add-paper-position)');
    assertEqual(routed._mode, 'paper', '_mode envelope must read "paper"');
  });

  test('get-portfolio routes to get-paper-portfolio shape under PAPER_MODE', () => {
    const routed = dbq('get-portfolio --chain base', true);
    assertEqual(routed._mode, 'paper', '_mode envelope must mark paper');
    assert(routed.cash !== undefined, 'paper portfolio must have cash');
    assert(Array.isArray(routed.positions), 'paper portfolio must have positions array');
  });

  test('get-receipts routes to paper_receipts under PAPER_MODE', () => {
    // Returns array even when empty; verifies the route doesn't error against real receipts.
    const routed = dbq('get-receipts --limit 5', true);
    assert(Array.isArray(routed), 'get-receipts must return array');
  });
});

describe('Mode Routing — paper-* names remain silent aliases', () => {
  test('explicit get-paper-positions still works', () => {
    const explicit = dbq('get-paper-positions --status open', true);
    assertEqual(explicit.length, 1, 'explicit name must keep working');
  });

  test('explicit set-paper-cash still works (entrypoint.sh depends on it)', () => {
    const r = dbq('set-paper-cash --chain solana --amount 2000', true);
    assert(r.ok, 'set-paper-cash must keep working');
    const check = dbq('get-paper-cash --chain solana', true);
    assertEqual(check.cash, 2000, 'set-paper-cash must write paper_cash_solana');
  });

  test('explicit get-paper-portfolio still works', () => {
    const r = dbq('get-paper-portfolio --chain base', true);
    assert(r.cash !== undefined, 'must return paper portfolio shape');
  });
});

describe('Mode Routing — _mode envelope', () => {
  test('_mode is "paper" on object responses under PAPER_MODE', () => {
    const r = dbq('get-cash --chain base', true);
    assertEqual(r._mode, 'paper', '_mode must be paper');
  });

  test('_mode is "real" on object responses without PAPER_MODE', () => {
    const r = dbq('get-cash --chain base', false);
    assertEqual(r._mode, 'real', '_mode must be real');
  });

  test('_mode tracks the actual table queried, even via explicit alias', () => {
    // Calling get-paper-portfolio without PAPER_MODE still queries paper tables.
    // _mode reflects the env var (operator's intent), which is the most useful signal
    // for catching forgotten-env-var bugs. The explicit name carries its own meaning.
    const r = dbq('get-paper-portfolio --chain base', false);
    assertEqual(r._mode, 'real', '_mode reflects PAPER_MODE env var');
    assert(r.cash !== undefined, 'paper portfolio shape regardless');
  });

  test('arrays are not wrapped (backward compat)', () => {
    const r = dbq('get-positions --status open', true);
    assert(Array.isArray(r), 'array responses must remain raw arrays');
    // No _mode field on arrays, by design.
  });
});

describe('Mode Routing — intentionally NOT auto-routed', () => {
  test('add-position is not auto-routed (different schema from add-paper-position)', () => {
    // add-position takes quantity directly; add-paper-position takes value_usd and auto-deducts cash.
    // Auto-routing would silently change the call shape — keep them explicit.
    let routedToPaper = false;
    try {
      dbq(
        `add-position --json '${JSON.stringify({
          id: 'mr-real-pos',
          symbol: 'REALT',
          address: '0xreal1',
          chain: 'base',
          tier: 'base',
          entry_price: 1,
          current_price: 1,
          quantity: 100,
          value_usd: 100,
          stop_loss: 0.5,
          take_profit_levels: [{ level: 1, price: 2, sellPercent: 100 }],
          status: 'open',
        })}'`,
        true,
      );
    } catch (e) {
      routedToPaper = /paper/.test(e.message);
    }
    // Should succeed against the REAL positions table even with PAPER_MODE=true
    const realPos = dbq('get-positions --status open', false);
    assert(
      realPos.some((p) => p.id === 'mr-real-pos'),
      'add-position must write to real positions table even under PAPER_MODE',
    );
    assert(!routedToPaper, 'add-position did not route to paper');
  });
});

describe('Mode Routing — Stats unification', () => {
  // Seed live-mode trade rows so get-trade-stats has data to aggregate.
  // (Phase 0 already seeded paper_cash, real cash, paper position.)
  test('seed real-mode trade history + total_deposited', () => {
    dbq(
      `add-trade --json '${JSON.stringify({
        id: 'mr-trade-1',
        symbol: 'REALT',
        address: '0xreal1',
        chain: 'base',
        tier: 'base',
        action: 'sell',
        entry_price: 1,
        exit_price: 1.2,
        quantity: 100,
        entry_date: '2026-04-01',
        exit_date: '2026-04-15',
        pnl_percent: 20,
        pnl_usd: 20,
        exit_reason: 'tp1_hit',
        analysis_score: 70,
        risk_score: 30,
        narrative: 'test',
        lesson: 'unit-test',
        duration_days: 14,
      })}'`,
      false,
    );
    // Seed total_deposited so initial_balance computes
    dbq(`set-meta --key total_deposited_base --value 5000`, false);
  });

  test('get-trade-stats in live mode returns enriched shape', () => {
    const live = dbq('get-trade-stats --chain base', false);
    assertEqual(live._mode, 'real', '_mode must mark real');
    assertEqual(live.chain, 'base', 'chain field reflects --chain filter');
    assert(live.total_trades >= 1, 'must aggregate from trades table');
    assert(live.initial_balance === 5000, 'initial_balance reads total_deposited_base');
    assert(live.current_value !== undefined, 'must compute current_value');
    assert(live.total_return_percent !== undefined, 'must compute total_return_percent');
    assert(live.win_rate !== undefined, 'must compute win_rate');
  });

  test('get-trade-stats under PAPER_MODE auto-routes to paper handler', () => {
    const paper = dbq('get-trade-stats --chain base', true);
    assertEqual(paper._mode, 'paper', '_mode must mark paper after auto-route');
    assert(paper.initial_balance !== undefined, 'paper handler returns initial_balance');
    assert(paper.current_value !== undefined, 'paper handler returns current_value');
    assert(paper.total_return_percent !== undefined, 'paper handler returns total_return_percent');
    assert(paper.win_rate !== undefined, 'paper handler returns win_rate');
  });

  test('explicit get-paper-stats still works (backward compat)', () => {
    const r = dbq('get-paper-stats --chain base', true);
    assertEqual(r._mode, 'paper', 'explicit name still queries paper tables');
    assert(r.current_value !== undefined, 'returns paper-stats shape');
  });

  test('live + paper share the same field set', () => {
    const live = dbq('get-trade-stats --chain base', false);
    const paper = dbq('get-trade-stats --chain base', true);
    const sharedKeys = [
      'total_trades',
      'wins',
      'losses',
      'avg_win_percent',
      'avg_loss_percent',
      'total_pnl_usd',
      'best_trade_pnl',
      'worst_trade_pnl',
      'win_rate',
      'current_value',
      'initial_balance',
      'total_return_percent',
      'chain',
      '_mode',
    ];
    for (const k of sharedKeys) {
      assert(k in live, `live must have key ${k}`);
      assert(k in paper, `paper must have key ${k}`);
    }
  });
});

describe('Mode Routing — Cleanup', () => {
  test('remove test database', () => {
    const dbPath = resolve(PROJECT_ROOT, 'data', `${SAFE_ID}.db`);
    if (existsSync(dbPath)) unlinkSync(dbPath);
    // also clean the WAL/SHM
    for (const ext of ['-wal', '-shm']) {
      const p = dbPath + ext;
      if (existsSync(p)) unlinkSync(p);
    }
  });
});

const ok = summary();
process.exit(ok ? 0 : 1);
