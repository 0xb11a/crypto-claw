#!/usr/bin/env node
/**
 * Test Suite: End-to-End Paper Mode
 *
 * Simulates the full paper trading lifecycle through db-query.js CLI commands
 * — exactly as the agents call them. Tests the complete flow:
 *
 *   1. Research: auto-approve trade → add-order (action=buy)
 *   2. Executor: read pending → add-paper-receipt → add-paper-position (auto-deducts cash) → mark executed
 *   3. Sentinel: get-paper-positions → detect stop-loss → add-order (action=sell)
 *   4. Executor: read sell order → close-paper-position (auto-updates cash) → add-paper-receipt (sell) → mark executed
 *   5. Verify final state
 *   6. Happy path: buy → TP1 partial sell
 *
 * Uses a unique SAFE_ID per run to avoid interfering with real data.
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { unlinkSync } from 'fs';
import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

const PROJECT_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const DB_QUERY = resolve(PROJECT_ROOT, 'scripts/db-query.js');
const SAFE_ID = `e2e-test-${Date.now()}`;

/** Run a db-query.js command, return parsed JSON output */
function dbq(command) {
  const output = execSync(`node ${DB_QUERY} ${command}`, {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
    timeout: 10_000,
  }).trim();
  // db-query.js may print migration logs to stdout before JSON — take last JSON block
  const lines = output.split('\n');
  const jsonStart = lines.findIndex((l) => l.startsWith('{') || l.startsWith('['));
  const jsonStr = lines.slice(jsonStart).join('\n');
  return JSON.parse(jsonStr);
}

// ============================================================
// Setup
// ============================================================
describe('E2E Setup', () => {
  test('migrations run successfully', () => {
    const result = dbq('migrate');
    assert(result.ok, 'Migration must return ok: true');
  });

  test('seed paper cash to $10,000 on base', () => {
    const result = dbq('set-paper-cash --chain base --amount 10000');
    assert(result.ok, 'set-paper-cash must return ok');
  });

  test('verify starting paper cash on base', () => {
    const result = dbq('get-paper-cash --chain base');
    assertEqual(result.cash, 10000, 'Starting cash should be $10,000');
  });

  test('verify no open paper positions', () => {
    const result = dbq('get-paper-positions --status open');
    assert(Array.isArray(result), 'get-paper-positions must return array');
    assertEqual(result.length, 0, 'Should start with 0 positions');
  });
});

// ============================================================
// Step 1: Research Agent — auto-approve BUY
// ============================================================
describe('E2E Step 1: Research → Auto-Approve Trade', () => {
  test('add auto-approved trade', () => {
    const trade = {
      id: 'e2e-trade-001',
      symbol: 'E2ETEST',
      address: '0xe2etest123',
      chain: 'base',
      action: 'buy',
      amount: 500,
      percent_of_portfolio: 5,
      tier: 'moonshot',
      entry_price: 0.001,
      stop_loss: 0.0005,
      take_profit_levels: JSON.stringify([
        { level: 1, price: 0.002, sellPercent: 50 },
        { level: 2, price: 0.005, sellPercent: 30 },
      ]),
      analysis_score: 76,
      risk_score: 20,
      reasoning: 'E2E test trade',
    };
    const result = dbq(`add-order --json '${JSON.stringify(trade)}'`);
    assert(result.ok, 'add-order must succeed');
  });

  test('trade appears as pending', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'e2e-trade-001');
    assert(trade, 'Trade must appear in pending list');
    assertEqual(trade.status, 'approved', 'Must be approved');
    assertEqual(trade.approved_by, 'paper_mode', 'Must be auto-approved');
  });
});

// ============================================================
// Step 2: Executor Agent — process BUY (paper)
// ============================================================
describe('E2E Step 2: Executor → Paper Buy', () => {
  test('executor reads pending trade', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'e2e-trade-001');
    assert(trade, 'Must find pending trade');
  });

  test('executor validates paper cash is sufficient', () => {
    const result = dbq('get-paper-cash --chain base');
    assert(result.cash >= 500, `Cash ${result.cash} must cover $500 trade`);
  });

  test('executor records paper trade', () => {
    const result = dbq(
      `add-paper-receipt --json '${JSON.stringify({
        id: 'e2e-ptrade-buy-001',
        order_id: 'e2e-trade-001',
        action: 'buy',
        symbol: 'E2ETEST',
        address: '0xe2etest123',
        chain: 'base',
        tier: 'moonshot',
        proposed_price: 0.001,
        quantity: 500000,
        amount: 500,
      })}'`,
    );
    assert(result.ok, 'add-paper-receipt must succeed');
  });

  test('executor creates paper position', () => {
    const result = dbq(
      `add-paper-position --json '${JSON.stringify({
        id: 'e2e-pos-001',
        symbol: 'E2ETEST',
        address: '0xe2etest123',
        chain: 'base',
        tier: 'moonshot',
        entry_price: 0.001,
        current_price: 0.001,
        quantity: 500000,
        amount_usd: 500,
        stop_loss: 0.0005,
        take_profit_levels: JSON.stringify([
          { level: 1, price: 0.002, sellPercent: 50 },
          { level: 2, price: 0.005, sellPercent: 30 },
        ]),
        status: 'open',
      })}'`,
    );
    assert(result.ok, 'add-paper-position must succeed');
  });

  test('executor verifies cash auto-deducted by add-paper-position', () => {
    const result = dbq('get-paper-cash --chain base');
    assertEqual(result.cash, 9500, 'Cash auto-deducted: $10,000 - $500 = $9,500');
  });

  test('executor marks trade as executed', () => {
    const result = dbq('mark-order-executed --id e2e-trade-001');
    assert(result.ok, 'mark-order-executed must succeed');
  });

  test('trade no longer pending', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'e2e-trade-001');
    assert(!trade, 'Executed trade must not be pending');
  });

  test('paper portfolio reflects the buy', () => {
    const cash = dbq('get-paper-cash --chain base');
    assertEqual(cash.cash, 9500, 'Cash should be $9,500');

    const positions = dbq('get-paper-positions --status open');
    assertEqual(positions.length, 1, 'Should have 1 open position');
    assertEqual(positions[0].symbol, 'E2ETEST', 'Symbol must match');
    assertEqual(positions[0].quantity, 500000, 'Quantity must match');
  });
});

// ============================================================
// Step 3: Sentinel — detect stop-loss, write sell order
// ============================================================
describe('E2E Step 3: Sentinel → Stop-Loss → Sell Order', () => {
  test('sentinel reads paper positions (not real)', () => {
    const paperPos = dbq('get-paper-positions --status open');
    assert(paperPos.length > 0, 'Sentinel must see paper positions');

    const realPos = dbq('get-positions --status open');
    assertEqual(realPos.length, 0, 'Real positions must be empty');
  });

  test('sentinel detects stop-loss hit', () => {
    const pos = dbq('get-paper-positions --status open')[0];
    const currentPrice = 0.0004;
    assert(currentPrice <= pos.stop_loss, `Price ${currentPrice} triggers stop at ${pos.stop_loss}`);
  });

  test('sentinel writes sell order', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'e2e-sell-001',
        action: 'sell',
        symbol: 'E2ETEST',
        address: '0xe2etest123',
        chain: 'base',
        amount: 'all',
        reason: 'stop_loss',
        urgency: 'immediate',
      })}'`,
    );
    assert(result.ok, 'add-order must succeed');
  });

  test('sentinel writes alert', () => {
    const result = dbq(
      `add-alert --json '${JSON.stringify({
        id: 'e2e-alert-001',
        symbol: 'E2ETEST',
        chain: 'base',
        alert_type: 'stop_loss',
        severity: 'critical',
        current_price: 0.0004,
        trigger_price: 0.0005,
        details: 'Stop-loss hit',
        action: 'sell_all',
      })}'`,
    );
    assert(result.ok, 'add-alert must succeed');
  });

  test('sell order appears as pending', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'e2e-sell-001');
    assert(order, 'Sell order must be pending');
    assertEqual(order.reason, 'stop_loss', 'Reason must be stop_loss');
  });
});

// ============================================================
// Step 4: Executor — process SELL (paper)
// ============================================================
describe('E2E Step 4: Executor → Paper Sell', () => {
  test('executor reads pending sell order', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'e2e-sell-001');
    assert(order, 'Must find pending sell order');
  });

  test('executor validates paper position exists', () => {
    const positions = dbq('get-paper-positions --status open');
    const pos = positions.find((p) => p.symbol === 'E2ETEST');
    assert(pos, 'Position must exist in paper_positions');
  });

  test('executor records paper sell trade with P&L', () => {
    const sellProceeds = 500000 * 0.0004; // $200
    const result = dbq(
      `add-paper-receipt --json '${JSON.stringify({
        id: 'e2e-ptrade-sell-001',
        order_id: 'e2e-sell-001',
        action: 'sell',
        symbol: 'E2ETEST',
        address: '0xe2etest123',
        chain: 'base',
        tier: 'moonshot',
        proposed_price: 0.0004,
        quantity: 500000,
        amount: sellProceeds,
        pnl_percent: -60,
        pnl_usd: sellProceeds - 500,
      })}'`,
    );
    assert(result.ok, 'add-paper-receipt (sell) must succeed');
  });

  test('executor closes paper position', () => {
    const result = dbq(
      `close-paper-position --id e2e-pos-001 --json '${JSON.stringify({
        exit_price: 0.0004,
        exit_reason: 'stop_loss',
      })}'`,
    );
    assert(result.ok, 'close-paper-position must succeed');
  });

  test('executor verifies cash auto-updated by close-paper-position', () => {
    // Had $9,500 + $200 proceeds = $9,700
    const result = dbq('get-paper-cash --chain base');
    assertEqual(result.cash, 9700, 'Cash auto-updated: $9,500 + $200 proceeds = $9,700');
  });

  test('executor marks sell order as executed', () => {
    const result = dbq('mark-order-executed --id e2e-sell-001');
    assert(result.ok, 'mark-order-executed must succeed');
  });

  test('sell order no longer pending', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'e2e-sell-001');
    assert(!order, 'Executed sell must not be pending');
  });
});

// ============================================================
// Step 5: Verify final state
// ============================================================
describe('E2E Step 5: Final State Verification', () => {
  test('no open paper positions', () => {
    const positions = dbq('get-paper-positions --status open');
    assertEqual(positions.length, 0, 'Should have 0 open positions');
  });

  test('closed position has correct P&L', () => {
    const positions = dbq('get-paper-positions --status closed');
    const pos = positions.find((p) => p.id === 'e2e-pos-001');
    assert(pos, 'Closed position must exist');
    assertEqual(pos.exit_price, 0.0004, 'Exit price must match');
    assertEqual(pos.exit_reason, 'stop_loss', 'Exit reason must be stop_loss');
  });

  test('paper cash reflects the loss', () => {
    const result = dbq('get-paper-cash --chain base');
    assertEqual(result.cash, 9700, 'Cash: $10k - $500 buy + $200 sale = $9,700');
  });

  test('paper trades show buy and sell', () => {
    const trades = dbq('get-paper-receipts --limit 50');
    const buy = trades.find((t) => t.id === 'e2e-ptrade-buy-001');
    const sell = trades.find((t) => t.id === 'e2e-ptrade-sell-001');
    assert(buy, 'Buy trade must exist');
    assert(sell, 'Sell trade must exist');
    assertEqual(buy.action, 'buy', 'Buy action');
    assertEqual(sell.action, 'sell', 'Sell action');
    assertEqual(sell.pnl_usd, -300, 'Sell P&L: -$300');
  });

  test('approved trade marked executed', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'e2e-trade-001');
    assert(!trade, 'Must not be pending');
  });

  test('sell order marked executed', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'e2e-sell-001');
    assert(!order, 'Must not be pending');
  });

  test('alert was recorded', () => {
    const alerts = dbq('get-alerts --unprocessed');
    const alert = alerts.find((a) => a.id === 'e2e-alert-001');
    assert(alert, 'Alert must exist');
    assertEqual(alert.alert_type, 'stop_loss', 'Alert type');
  });

  test('paper portfolio summary consistent', () => {
    const portfolio = dbq('get-paper-portfolio');
    assertEqual(portfolio.cash, 9700, 'Portfolio cash');
    assertEqual(portfolio.positions.length, 0, 'No open positions in summary');
    assertEqual(portfolio.total_value, 9700, 'Total value matches cash when no positions');
    assertEqual(portfolio.pnl, -300, 'P&L reflects the loss');
    assert(portfolio.realized_pnl !== undefined, 'Has realized_pnl field');
    assert(portfolio.closed_positions.length > 0, 'Has closed positions history');
    assert(portfolio.recent_trades.length > 0, 'Has recent trades');
  });
});

// ============================================================
// Step 6: Happy path — buy → TP1 partial sell
// ============================================================
describe('E2E Step 6: Happy Path — TP1 Partial Sell', () => {
  test('research auto-approves second trade', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'e2e-trade-002',
        symbol: 'E2EWIN',
        address: '0xe2ewin456',
        chain: 'base',
        action: 'buy',
        amount: 400,
        percent_of_portfolio: 4,
        tier: 'moonshot',
        entry_price: 0.01,
        stop_loss: 0.005,
        take_profit_levels: JSON.stringify([{ level: 1, price: 0.02, sellPercent: 50 }]),
        analysis_score: 82,
        risk_score: 15,
        reasoning: 'E2E happy path',
      })}'`,
    );
    assert(result.ok, 'Trade approved');
  });

  test('executor buys paper position', () => {
    dbq(
      `add-paper-receipt --json '${JSON.stringify({
        id: 'e2e-ptrade-buy-002',
        order_id: 'e2e-trade-002',
        action: 'buy',
        symbol: 'E2EWIN',
        address: '0xe2ewin456',
        chain: 'base',
        tier: 'moonshot',
        proposed_price: 0.01,
        quantity: 40000,
        amount: 400,
      })}'`,
    );

    dbq(
      `add-paper-position --json '${JSON.stringify({
        id: 'e2e-pos-002',
        symbol: 'E2EWIN',
        address: '0xe2ewin456',
        chain: 'base',
        tier: 'moonshot',
        entry_price: 0.01,
        current_price: 0.01,
        quantity: 40000,
        amount_usd: 400,
        stop_loss: 0.005,
        take_profit_levels: JSON.stringify([{ level: 1, price: 0.02, sellPercent: 50 }]),
        status: 'open',
      })}'`,
    );

    // Cash auto-deducted by add-paper-position: $9,700 - $400 = $9,300
    dbq('mark-order-executed --id e2e-trade-002');

    const positions = dbq('get-paper-positions --status open');
    assertEqual(positions.length, 1, 'Should have 1 open position');
    assertEqual(positions[0].symbol, 'E2EWIN', 'Symbol must match');
  });

  test('sentinel detects TP1, writes partial sell order', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'e2e-sell-002',
        action: 'sell',
        symbol: 'E2EWIN',
        address: '0xe2ewin456',
        chain: 'base',
        amount: '50%',
        reason: 'tp1_hit',
        urgency: 'immediate',
      })}'`,
    );
    assert(result.ok, 'Partial sell order created');
  });

  test('executor processes partial sell', () => {
    const sellQty = 20000;
    const sellProceeds = sellQty * 0.021; // $420

    dbq(
      `add-paper-receipt --json '${JSON.stringify({
        id: 'e2e-ptrade-sell-002',
        order_id: 'e2e-sell-002',
        action: 'sell',
        symbol: 'E2EWIN',
        address: '0xe2ewin456',
        chain: 'base',
        tier: 'moonshot',
        proposed_price: 0.021,
        quantity: sellQty,
        amount: sellProceeds,
        pnl_percent: 110,
        pnl_usd: sellProceeds - 200,
      })}'`,
    );

    dbq(
      `update-paper-position --id e2e-pos-002 --json '${JSON.stringify({
        quantity: 20000,
        current_price: 0.021,
      })}'`,
    );

    dbq(`set-paper-cash --chain base --amount ${9300 + sellProceeds}`);
    dbq('mark-order-executed --id e2e-sell-002');

    const cash = dbq('get-paper-cash --chain base');
    assertEqual(cash.cash, 9720, 'Cash: $9,300 + $420 = $9,720');
  });

  test('position still open with reduced quantity', () => {
    const positions = dbq('get-paper-positions --status open');
    assertEqual(positions.length, 1, 'Position still open');
    assertEqual(positions[0].quantity, 20000, 'Quantity halved');
  });

  test('portfolio shows profit vs initial', () => {
    const portfolio = dbq('get-paper-portfolio');
    assert(portfolio.cash >= 9700, 'Cash reflects partial sell profit');
    assertEqual(portfolio.positions.length, 1, 'Still holding moonbag');
  });
});

// ============================================================
// Step 7: Multi-Chain — Solana buy with independent cash
// ============================================================
describe('E2E Step 7: Multi-Chain Cash Isolation', () => {
  test('seed Solana paper cash', () => {
    const result = dbq('set-paper-cash --chain solana --amount 3000');
    assert(result.ok, 'set-paper-cash solana must return ok');
  });

  test('Solana cash is independent from Base', () => {
    const baseCash = dbq('get-paper-cash --chain base');
    const solCash = dbq('get-paper-cash --chain solana');
    assert(baseCash.cash >= 9700, 'Base cash should be from prior trades');
    assertEqual(solCash.cash, 3000, 'Solana cash should be freshly seeded');
  });

  test('buy on Solana deducts from Solana cash only', () => {
    const baseBefore = dbq('get-paper-cash --chain base').cash;

    dbq(
      `add-paper-receipt --json '${JSON.stringify({
        id: 'e2e-ptrade-sol-001',
        order_id: 'e2e-trade-sol',
        action: 'buy',
        symbol: 'SOLTEST',
        address: 'SoLtEsT1111111111111111111111111111111111111',
        chain: 'solana',
        tier: 'moonshot',
        proposed_price: 0.5,
        quantity: 1000,
        amount: 500,
      })}'`,
    );

    dbq(
      `add-paper-position --json '${JSON.stringify({
        id: 'e2e-pos-sol-001',
        symbol: 'SOLTEST',
        address: 'SoLtEsT1111111111111111111111111111111111111',
        chain: 'solana',
        tier: 'moonshot',
        entry_price: 0.5,
        current_price: 0.5,
        quantity: 1000,
        amount_usd: 500,
        stop_loss: 0.25,
        take_profit_levels: JSON.stringify([{ level: 1, price: 1.0, sellPercent: 50 }]),
        status: 'open',
      })}'`,
    );

    const solCash = dbq('get-paper-cash --chain solana');
    assertEqual(solCash.cash, 2500, 'Solana: $3000 - $500 = $2500');

    const baseAfter = dbq('get-paper-cash --chain base').cash;
    assertEqual(baseAfter, baseBefore, 'Base cash unchanged');
  });

  test('close Solana position updates Solana cash only', () => {
    const baseBefore = dbq('get-paper-cash --chain base').cash;

    dbq(
      `close-paper-position --id e2e-pos-sol-001 --json '${JSON.stringify({
        exit_price: 0.75,
        exit_reason: 'tp1_hit',
      })}'`,
    );

    const solCash = dbq('get-paper-cash --chain solana');
    // $2500 + (0.75 * 1000) = $2500 + $750 = $3250
    assertEqual(solCash.cash, 3250, 'Solana: $2500 + $750 proceeds = $3250');

    const baseAfter = dbq('get-paper-cash --chain base').cash;
    assertEqual(baseAfter, baseBefore, 'Base cash still unchanged');
  });

  test('get-paper-portfolio --chain solana shows only Solana data', () => {
    const portfolio = dbq('get-paper-portfolio --chain solana');
    assertEqual(portfolio.chain, 'solana', 'Should be filtered to solana');
    assertEqual(portfolio.positions.length, 0, 'No open Solana positions');
    assertEqual(portfolio.cash, 3250, 'Cash should be Solana-only');
  });
});

// ============================================================
// Step 8: Error handling — missing --chain on required commands
// ============================================================
describe('E2E Step 8: Missing --chain Errors', () => {
  test('set-cash without --chain returns error', () => {
    let threw = false;
    try {
      dbq('set-cash --amount 5000');
    } catch {
      threw = true;
    }
    assert(threw, 'set-cash must require --chain');
  });

  test('set-paper-cash without --chain returns error', () => {
    let threw = false;
    try {
      dbq('set-paper-cash --amount 5000');
    } catch {
      threw = true;
    }
    assert(threw, 'set-paper-cash must require --chain');
  });

  test('get-portfolio without --chain returns per-chain breakdown', () => {
    const result = dbq('get-portfolio');
    assert(result.chains, 'Must have chains key');
    assert(result.chains.base, 'Must have base chain');
    assert(result.chains.solana, 'Must have solana chain');
    assert(result.total_value !== undefined, 'Must have total_value');
  });
});

// ============================================================
// Cleanup
// ============================================================
describe('E2E Cleanup', () => {
  test('remove test database', () => {
    const dbPath = resolve(PROJECT_ROOT, 'data', `${SAFE_ID}.db`);
    try {
      unlinkSync(dbPath);
    } catch {
      /* ok */
    }
    try {
      unlinkSync(dbPath + '-wal');
    } catch {
      /* ok */
    }
    try {
      unlinkSync(dbPath + '-shm');
    } catch {
      /* ok */
    }
    assert(true, 'Cleanup complete');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
