#!/usr/bin/env node
/**
 * Test Suite: End-to-End Real Mode
 *
 * Simulates the full real-mode trading lifecycle through db-query.js CLI commands
 * — exactly as the agents call them. Tests the complete flow using real-mode tables
 * (positions, receipts, cash_base/cash_solana).
 *
 *   1. Setup: seed cash for both chains, verify clean state
 *   2. Research: approve BUY on Base → add-order (action=buy)
 *   3. Executor: process BUY → add-receipt → add-position → set-cash (deduct)
 *   4. Sentinel: detect stop-loss → add-order (action=sell)
 *   5. Executor: process SELL → add-receipt → remove-position → set-cash (add proceeds)
 *   6. Verify final state (receipts, positions closed, cash reconciled)
 *   7. Same flow on Solana — verify cross-chain cash isolation
 *   8. Happy path — TP1 partial sell via update-position
 *   9. Portfolio sync metadata — verify set-meta/get-meta for sync timestamps
 *
 * Does NOT call execute-trade.js or execute-trade-solana.js (no real wallets needed).
 * Uses a unique SAFE_ID per run to avoid interfering with real data.
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { unlinkSync } from 'fs';
import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

const PROJECT_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');
const DB_QUERY = resolve(PROJECT_ROOT, 'scripts/db-query.js');
const SAFE_ID = `e2e-real-${Date.now()}`;

/** Run a db-query.js command, return parsed JSON output */
function dbq(command) {
  const output = execSync(`node ${DB_QUERY} ${command}`, {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    env: { ...process.env, SAFE_ID, PAPER_MODE: 'false' },
    timeout: 10_000,
  }).trim();
  const lines = output.split('\n');
  const jsonStart = lines.findIndex((l) => l.startsWith('{') || l.startsWith('['));
  const jsonStr = lines.slice(jsonStart).join('\n');
  return JSON.parse(jsonStr);
}

// ============================================================
// Step 1: Setup
// ============================================================
describe('E2E Real Setup', () => {
  test('migrations run successfully', () => {
    const result = dbq('migrate');
    assert(result.ok, 'Migration must return ok: true');
  });

  test('seed Base cash to $5,000', () => {
    const result = dbq('set-cash --chain base --amount 5000');
    assert(result.ok, 'set-cash base must return ok');
  });

  test('seed Solana cash to $3,000', () => {
    const result = dbq('set-cash --chain solana --amount 3000');
    assert(result.ok, 'set-cash solana must return ok');
  });

  test('verify starting cash', () => {
    const baseCash = dbq('get-cash --chain base');
    assertEqual(baseCash.cash, 5000, 'Base cash should be $5,000');

    const solCash = dbq('get-cash --chain solana');
    assertEqual(solCash.cash, 3000, 'Solana cash should be $3,000');
  });

  test('verify no open positions', () => {
    const result = dbq('get-positions --status open');
    assert(Array.isArray(result), 'get-positions must return array');
    assertEqual(result.length, 0, 'Should start with 0 positions');
  });

  test('verify no pending receipts', () => {
    const result = dbq('get-receipts --limit 10');
    assert(Array.isArray(result), 'get-receipts must return array');
    assertEqual(result.length, 0, 'Should start with 0 receipts');
  });
});

// ============================================================
// Step 2: Research Agent — approve BUY on Base
// ============================================================
describe('E2E Real Step 2: Research → Approve Trade', () => {
  test('add approved trade for Base', () => {
    const trade = {
      id: 'real-trade-001',
      symbol: 'REALTEST',
      name: 'Real Test Token',
      address: '0xrealtest001',
      chain: 'base',
      action: 'buy',
      amount: 500,
      percent_of_portfolio: 10,
      tier: 'conviction',
      entry_price: 2.5,
      stop_loss: 1.75,
      take_profit_levels: JSON.stringify([
        { level: 1, price: 5.0, sellPercent: 50 },
        { level: 2, price: 10.0, sellPercent: 30 },
      ]),
      analysis_score: 82,
      risk_score: 18,
      reasoning: 'E2E real mode test',
    };
    const result = dbq(`add-order --json '${JSON.stringify(trade)}'`);
    assert(result.ok, 'add-order must succeed');
  });

  test('trade starts as pending in real mode', () => {
    const trades = dbq('get-orders --status pending');
    const trade = trades.find((t) => t.id === 'real-trade-001');
    assert(trade, 'Trade must appear in pending list');
    assertEqual(trade.status, 'pending', 'Real mode buys start as pending');
  });

  test('approve trade for executor pickup', () => {
    const result = dbq('approve-order --id real-trade-001 --by human');
    assert(result.ok, 'approve-order must succeed');
  });

  test('trade appears as approved', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'real-trade-001');
    assert(trade, 'Trade must appear in pending list');
    assertEqual(trade.status, 'approved', 'Must be approved');
    assertEqual(trade.approved_by, 'human', 'Must be human-approved');
  });
});

// ============================================================
// Step 3: Executor Agent — process BUY (real mode)
// ============================================================
describe('E2E Real Step 3: Executor → Buy', () => {
  test('executor validates cash is sufficient', () => {
    const result = dbq('get-cash --chain base');
    assert(result.cash >= 500, `Cash ${result.cash} must cover $500 trade`);
  });

  test('executor records receipt', () => {
    const result = dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-buy-001',
        order_id: 'real-trade-001',

        action: 'buy',
        symbol: 'REALTEST',
        address: '0xrealtest001',
        chain: 'base',
        amount: 500,
        quantity: 200,
        expected_price: 2.5,
        executed_price: 2.52,
        slippage: 0.008,
        status: 'executed',
        safe_tx_hash: '0xfake_safe_hash_001',
        onchain_tx_hash: '0xfake_onchain_hash_001',
      })}'`,
    );
    assert(result.ok, 'add-receipt must succeed');
  });

  test('executor creates position', () => {
    const result = dbq(
      `add-position --json '${JSON.stringify({
        id: 'pos-real-001',
        symbol: 'REALTEST',
        name: 'Real Test Token',
        address: '0xrealtest001',
        chain: 'base',
        tier: 'conviction',
        entry_price: 2.52,
        current_price: 2.52,
        quantity: 200,
        value_usd: 504,
        percent_of_portfolio: 10,
        stop_loss: 1.75,
        take_profit_levels: JSON.stringify([
          { level: 1, price: 5.0, sellPercent: 50 },
          { level: 2, price: 10.0, sellPercent: 30 },
        ]),
        status: 'open',
      })}'`,
    );
    assert(result.ok, 'add-position must succeed');
  });

  test('executor deducts cash', () => {
    const result = dbq('set-cash --chain base --amount 4496');
    assert(result.ok, 'set-cash must succeed');

    const cash = dbq('get-cash --chain base');
    assertEqual(cash.cash, 4496, 'Cash: $5000 - $504 = $4,496');
  });

  test('executor marks trade as executed', () => {
    const result = dbq('mark-order-executed --id real-trade-001');
    assert(result.ok, 'mark-order-executed must succeed');
  });

  test('trade no longer pending', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'real-trade-001');
    assert(!trade, 'Executed trade must not be pending');
  });

  test('position visible in portfolio', () => {
    const positions = dbq('get-positions --status open');
    assertEqual(positions.length, 1, 'Should have 1 open position');
    assertEqual(positions[0].symbol, 'REALTEST', 'Symbol must match');
    assertEqual(positions[0].quantity, 200, 'Quantity must match');
    assertEqual(positions[0].chain, 'base', 'Chain must be base');
  });
});

// ============================================================
// Step 4: Sentinel — detect stop-loss, write sell order
// ============================================================
describe('E2E Real Step 4: Sentinel → Stop-Loss → Sell Order', () => {
  test('sentinel reads real positions (not paper)', () => {
    const realPos = dbq('get-positions --status open');
    assert(realPos.length > 0, 'Sentinel must see real positions');
  });

  test('sentinel detects stop-loss hit', () => {
    const pos = dbq('get-positions --status open')[0];
    const currentPrice = 1.5;
    assert(currentPrice <= pos.stop_loss, `Price ${currentPrice} triggers stop at ${pos.stop_loss}`);
  });

  test('sentinel writes sell order', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'real-sell-001',
        action: 'sell',
        symbol: 'REALTEST',
        address: '0xrealtest001',
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
        id: 'real-alert-001',
        symbol: 'REALTEST',
        chain: 'base',
        alert_type: 'stop_loss',
        severity: 'critical',
        current_price: 1.5,
        trigger_price: 1.75,
        details: 'Stop-loss hit: $1.50 < $1.75',
        action: 'sell_all',
      })}'`,
    );
    assert(result.ok, 'add-alert must succeed');
  });

  test('sell order appears as pending', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'real-sell-001');
    assert(order, 'Sell order must be pending');
    assertEqual(order.reason, 'stop_loss', 'Reason must be stop_loss');
  });
});

// ============================================================
// Step 5: Executor — process SELL (real mode)
// ============================================================
describe('E2E Real Step 5: Executor → Sell', () => {
  test('executor reads pending sell order', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'real-sell-001');
    assert(order, 'Must find pending sell order');
  });

  test('executor records sell receipt', () => {
    const result = dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-sell-001',
        order_id: 'real-sell-001',

        action: 'sell',
        symbol: 'REALTEST',
        address: '0xrealtest001',
        chain: 'base',
        amount: 300,
        quantity: 200,
        expected_price: 1.5,
        executed_price: 1.48,
        slippage: 0.013,
        status: 'executed',
        safe_tx_hash: '0xfake_safe_hash_002',
        onchain_tx_hash: '0xfake_onchain_hash_002',
      })}'`,
    );
    assert(result.ok, 'add-receipt (sell) must succeed');
  });

  test('executor closes position', () => {
    const result = dbq('remove-position --id pos-real-001');
    assert(result.ok, 'remove-position must succeed');
  });

  test('executor updates cash with sell proceeds', () => {
    // Had $4,496 + $296 proceeds (200 * $1.48) = $4,792
    const result = dbq('set-cash --chain base --amount 4792');
    assert(result.ok, 'set-cash must succeed');
  });

  test('executor marks sell order as executed', () => {
    const result = dbq('mark-order-executed --id real-sell-001');
    assert(result.ok, 'mark-order-executed must succeed');
  });

  test('sell order no longer pending', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'real-sell-001');
    assert(!order, 'Executed sell must not be pending');
  });
});

// ============================================================
// Step 6: Verify final state
// ============================================================
describe('E2E Real Step 6: Final State Verification', () => {
  test('no open positions', () => {
    const positions = dbq('get-positions --status open');
    assertEqual(positions.length, 0, 'Should have 0 open positions');
  });

  test('position is marked closed', () => {
    const positions = dbq('get-positions --status closed');
    const pos = positions.find((p) => p.id === 'pos-real-001');
    assert(pos, 'Closed position must exist');
    assertEqual(pos.status, 'closed', 'Status must be closed');
  });

  test('cash reflects the loss', () => {
    const result = dbq('get-cash --chain base');
    assertEqual(result.cash, 4792, 'Cash: $5000 - $504 buy + $296 sale = $4,792');
  });

  test('receipts show buy and sell', () => {
    const receipts = dbq('get-receipts --limit 50');
    const buy = receipts.find((r) => r.id === 'rcpt-buy-001');
    const sell = receipts.find((r) => r.id === 'rcpt-sell-001');
    assert(buy, 'Buy receipt must exist');
    assert(sell, 'Sell receipt must exist');
    assertEqual(buy.action, 'buy', 'Buy action');
    assertEqual(sell.action, 'sell', 'Sell action');
    assertEqual(buy.status, 'executed', 'Buy status');
    assertEqual(sell.status, 'executed', 'Sell status');
  });

  test('approved trade marked executed', () => {
    const trades = dbq('get-orders --action buy --pending');
    const trade = trades.find((t) => t.id === 'real-trade-001');
    assert(!trade, 'Must not be pending');
  });

  test('sell order marked executed', () => {
    const orders = dbq('get-orders --action sell --pending');
    const order = orders.find((o) => o.id === 'real-sell-001');
    assert(!order, 'Must not be pending');
  });

  test('alert was recorded', () => {
    const alerts = dbq('get-alerts --unprocessed');
    const alert = alerts.find((a) => a.id === 'real-alert-001');
    assert(alert, 'Alert must exist');
    assertEqual(alert.alert_type, 'stop_loss', 'Alert type');
  });

  test('portfolio summary consistent', () => {
    const portfolio = dbq('get-portfolio --chain base');
    assertEqual(portfolio.cash, 4792, 'Portfolio cash');
    assertEqual(portfolio.positions.length, 0, 'No open positions in summary');
  });

  test('Solana cash unchanged', () => {
    const result = dbq('get-cash --chain solana');
    assertEqual(result.cash, 3000, 'Solana cash should be untouched');
  });
});

// ============================================================
// Step 7: Solana flow — verify cross-chain cash isolation
// ============================================================
describe('E2E Real Step 7: Solana Cross-Chain Isolation', () => {
  test('add approved Solana trade', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'real-trade-sol-001',
        symbol: 'SOLTEST',
        name: 'Solana Test Token',
        address: 'SoLtEsT2222222222222222222222222222222222222',
        chain: 'solana',
        action: 'buy',
        amount: 600,
        percent_of_portfolio: 20,
        tier: 'moonshot',
        entry_price: 0.3,
        stop_loss: 0.15,
        take_profit_levels: JSON.stringify([{ level: 1, price: 0.6, sellPercent: 50 }]),
        analysis_score: 75,
        risk_score: 22,
        reasoning: 'Solana cross-chain test',
      })}'`,
    );
    assert(result.ok, 'Solana trade created');
  });

  test('approve Solana trade', () => {
    const result = dbq('approve-order --id real-trade-sol-001 --by human');
    assert(result.ok, 'approve-order must succeed');
  });

  test('executor buys on Solana', () => {
    const baseBefore = dbq('get-cash --chain base').cash;

    dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-sol-buy-001',
        order_id: 'real-trade-sol-001',

        action: 'buy',
        symbol: 'SOLTEST',
        address: 'SoLtEsT2222222222222222222222222222222222222',
        chain: 'solana',
        amount: 600,
        quantity: 2000,
        expected_price: 0.3,
        executed_price: 0.3,
        slippage: 0,
        status: 'executed',
        onchain_tx_hash: 'fakeSolTxSig001',
      })}'`,
    );

    dbq(
      `add-position --json '${JSON.stringify({
        id: 'pos-sol-001',
        symbol: 'SOLTEST',
        name: 'Solana Test Token',
        address: 'SoLtEsT2222222222222222222222222222222222222',
        chain: 'solana',
        tier: 'moonshot',
        entry_price: 0.3,
        current_price: 0.3,
        quantity: 2000,
        value_usd: 600,
        percent_of_portfolio: 20,
        stop_loss: 0.15,
        take_profit_levels: JSON.stringify([{ level: 1, price: 0.6, sellPercent: 50 }]),
        status: 'open',
      })}'`,
    );

    dbq('set-cash --chain solana --amount 2400');
    dbq('mark-order-executed --id real-trade-sol-001');

    const solCash = dbq('get-cash --chain solana');
    assertEqual(solCash.cash, 2400, 'Solana: $3000 - $600 = $2400');

    const baseAfter = dbq('get-cash --chain base').cash;
    assertEqual(baseAfter, baseBefore, 'Base cash unchanged by Solana buy');
  });

  test('sell Solana position updates Solana cash only', () => {
    const baseBefore = dbq('get-cash --chain base').cash;

    dbq(
      `add-order --json '${JSON.stringify({
        id: 'real-sell-sol-001',
        action: 'sell',
        symbol: 'SOLTEST',
        address: 'SoLtEsT2222222222222222222222222222222222222',
        chain: 'solana',
        amount: 'all',
        reason: 'stop_loss',
        urgency: 'immediate',
      })}'`,
    );

    // Sell at $0.20 — proceeds: 2000 * $0.20 = $400
    dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-sol-sell-001',
        order_id: 'real-sell-sol-001',

        action: 'sell',
        symbol: 'SOLTEST',
        address: 'SoLtEsT2222222222222222222222222222222222222',
        chain: 'solana',
        amount: 400,
        quantity: 2000,
        expected_price: 0.2,
        executed_price: 0.2,
        slippage: 0,
        status: 'executed',
        onchain_tx_hash: 'fakeSolTxSig002',
      })}'`,
    );

    dbq('remove-position --id pos-sol-001');
    // $2400 + $400 = $2800
    dbq('set-cash --chain solana --amount 2800');
    dbq('mark-order-executed --id real-sell-sol-001');

    const solCash = dbq('get-cash --chain solana');
    assertEqual(solCash.cash, 2800, 'Solana: $2400 + $400 = $2800');

    const baseAfter = dbq('get-cash --chain base').cash;
    assertEqual(baseAfter, baseBefore, 'Base cash still unchanged');
  });

  test('cross-chain portfolio shows both chains', () => {
    const portfolio = dbq('get-portfolio');
    assert(portfolio.chains, 'Must have chains key');
    assert(portfolio.chains.base, 'Must have base chain');
    assert(portfolio.chains.solana, 'Must have solana chain');
    assertEqual(portfolio.chains.base.cash, 4792, 'Base cash correct');
    assertEqual(portfolio.chains.solana.cash, 2800, 'Solana cash correct');
  });
});

// ============================================================
// Step 8: Happy path — TP1 partial sell via update-position
// ============================================================
describe('E2E Real Step 8: Happy Path — TP1 Partial Sell', () => {
  test('buy second token on Base', () => {
    dbq(
      `add-order --json '${JSON.stringify({
        id: 'real-trade-002',
        symbol: 'REALWIN',
        address: '0xrealwin002',
        chain: 'base',
        action: 'buy',
        amount: 400,
        percent_of_portfolio: 8,
        tier: 'conviction',
        entry_price: 1.0,
        stop_loss: 0.6,
        take_profit_levels: JSON.stringify([{ level: 1, price: 2.0, sellPercent: 50 }]),
        analysis_score: 85,
        risk_score: 12,
        reasoning: 'Happy path test',
      })}'`,
    );

    dbq('approve-order --id real-trade-002 --by human');

    dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-buy-002',
        order_id: 'real-trade-002',

        action: 'buy',
        symbol: 'REALWIN',
        address: '0xrealwin002',
        chain: 'base',
        amount: 400,
        quantity: 400,
        expected_price: 1.0,
        executed_price: 1.0,
        slippage: 0,
        status: 'executed',
        safe_tx_hash: '0xfake_safe_hash_003',
        onchain_tx_hash: '0xfake_onchain_hash_003',
      })}'`,
    );

    dbq(
      `add-position --json '${JSON.stringify({
        id: 'pos-real-002',
        symbol: 'REALWIN',
        address: '0xrealwin002',
        chain: 'base',
        tier: 'conviction',
        entry_price: 1.0,
        current_price: 1.0,
        quantity: 400,
        value_usd: 400,
        stop_loss: 0.6,
        take_profit_levels: JSON.stringify([{ level: 1, price: 2.0, sellPercent: 50 }]),
        status: 'open',
      })}'`,
    );

    // $4792 - $400 = $4392
    dbq('set-cash --chain base --amount 4392');
    dbq('mark-order-executed --id real-trade-002');

    const positions = dbq('get-positions --status open');
    assertEqual(positions.length, 1, 'Should have 1 open position');
    assertEqual(positions[0].symbol, 'REALWIN', 'Symbol must match');
  });

  test('sentinel detects TP1, writes partial sell order', () => {
    const result = dbq(
      `add-order --json '${JSON.stringify({
        id: 'real-sell-002',
        action: 'sell',
        symbol: 'REALWIN',
        address: '0xrealwin002',
        chain: 'base',
        amount: '50%',
        reason: 'tp1_hit',
        urgency: 'immediate',
      })}'`,
    );
    assert(result.ok, 'Partial sell order created');
  });

  test('executor processes partial sell', () => {
    const sellQty = 200; // 50% of 400
    const sellProceeds = sellQty * 2.1; // $420

    dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-sell-002',
        order_id: 'real-sell-002',

        action: 'sell',
        symbol: 'REALWIN',
        address: '0xrealwin002',
        chain: 'base',
        amount: sellProceeds,
        quantity: sellQty,
        expected_price: 2.0,
        executed_price: 2.1,
        slippage: -0.05,
        status: 'executed',
        safe_tx_hash: '0xfake_safe_hash_004',
        onchain_tx_hash: '0xfake_onchain_hash_004',
      })}'`,
    );

    // Update position: half quantity, mark partial_exit
    dbq(
      `update-position --id pos-real-002 --json '${JSON.stringify({
        quantity: 200,
        current_price: 2.1,
        status: 'partial_exit',
      })}'`,
    );

    // $4392 + $420 = $4812
    dbq('set-cash --chain base --amount 4812');
    dbq('mark-order-executed --id real-sell-002');
  });

  test('position still open with reduced quantity', () => {
    const positions = dbq('get-positions --status all');
    const pos = positions.find((p) => p.id === 'pos-real-002');
    assert(pos, 'Position must still exist');
    assertEqual(pos.quantity, 200, 'Quantity halved');
    assertEqual(pos.status, 'partial_exit', 'Status should be partial_exit');
  });

  test('cash reflects partial sell profit', () => {
    const cash = dbq('get-cash --chain base');
    assertEqual(cash.cash, 4812, 'Cash: $4392 + $420 = $4,812');
  });

  test('receipts show all transactions', () => {
    const receipts = dbq('get-receipts --limit 50');
    // Should have: rcpt-buy-001, rcpt-sell-001, rcpt-sol-buy-001, rcpt-sol-sell-001, rcpt-buy-002, rcpt-sell-002
    assert(receipts.length >= 6, `Should have at least 6 receipts, got ${receipts.length}`);
  });
});

// ============================================================
// Step 9: Portfolio sync metadata
// ============================================================
describe('E2E Real Step 9: Portfolio Sync Metadata', () => {
  test('set-meta stores sync timestamp', () => {
    const ts = new Date().toISOString();
    const result = dbq(`set-meta --key last_sync_base --value ${ts}`);
    assert(result.ok, 'set-meta must succeed');
  });

  test('get-meta retrieves sync timestamp', () => {
    const result = dbq('get-meta --key last_sync_base');
    assert(result.value, 'Must have value');
    assert(result.value.includes('T'), 'Value should be an ISO timestamp');
  });

  test('per-chain sync metadata is independent', () => {
    const ts = new Date().toISOString();
    dbq(`set-meta --key last_sync_solana --value ${ts}`);

    const baseMeta = dbq('get-meta --key last_sync_base');
    const solMeta = dbq('get-meta --key last_sync_solana');
    assert(baseMeta.value, 'Base sync meta must exist');
    assert(solMeta.value, 'Solana sync meta must exist');
    // They can be the same or different — just verify both exist
  });

  test('queued receipt status can be recorded', () => {
    // Simulate a queued-in-safe receipt
    const result = dbq(
      `add-receipt --json '${JSON.stringify({
        id: 'rcpt-queued-001',
        order_id: 'real-trade-002',

        action: 'buy',
        symbol: 'QUEUETEST',
        address: '0xqueuetest',
        chain: 'base',
        amount: 100,
        expected_price: 1.0,
        status: 'queued_in_safe',
        safe_tx_hash: '0xfake_queued_hash',
        signatures_collected: 1,
        signatures_required: 2,
      })}'`,
    );
    assert(result.ok, 'queued receipt must succeed');

    // Verify we can filter by status
    const queued = dbq('get-receipts --status queued_in_safe');
    assert(queued.length >= 1, 'Should find queued receipts');
    const r = queued.find((q) => q.id === 'rcpt-queued-001');
    assert(r, 'Queued receipt must be found');
    assertEqual(r.status, 'queued_in_safe', 'Status must be queued_in_safe');
    assertEqual(r.signatures_collected, 1, 'Signatures collected');
    assertEqual(r.signatures_required, 2, 'Signatures required');
  });
});

// ============================================================
// Cleanup
// ============================================================
describe('E2E Real Cleanup', () => {
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
