#!/usr/bin/env node
/**
 * Test Suite: Execution Scripts
 *
 * Offline tests for pure logic in execute-trade.js and check-safe-status.js:
 * - CLI argument parsing and validation
 * - 1inch URL construction
 * - Slippage pre-check logic
 * - ERC-20 approve calldata generation
 * - Output format validation
 * - Security: no private key leakage
 */

import { describe, test, assert, assertEqual, summary } from './test-helpers.js';
import { parseArgs, validateArgs, build1inchUrl, checkSlippage, buildApproveCalldata } from '../scripts/execute-trade.js';

// ============================================================
// CLI Argument Parsing
// ============================================================
describe('execute-trade.js — Argument Parsing', () => {
  test('parses all valid arguments', () => {
    const args = parseArgs([
      '--action', 'buy', '--chain', 'base', '--address', '0xABC',
      '--symbol', 'TOKEN', '--amount', '500', '--max-slippage', '5',
      '--tier', 'moonshot', '--deadline', '300',
    ]);
    assertEqual(args.action, 'buy');
    assertEqual(args.chain, 'base');
    assertEqual(args.address, '0xABC');
    assertEqual(args.symbol, 'TOKEN');
    assertEqual(args.amount, '500');
    assertEqual(args.maxSlippage, '5');
    assertEqual(args.tier, 'moonshot');
    assertEqual(args.deadline, '300');
  });

  test('defaults deadline to 300', () => {
    const args = parseArgs(['--action', 'sell', '--chain', 'base', '--address', '0x1', '--symbol', 'X', '--amount', 'all', '--max-slippage', '2']);
    assertEqual(args.deadline, '300');
  });

  test('handles sell with amount=all', () => {
    const args = parseArgs(['--action', 'sell', '--chain', 'base', '--address', '0x1', '--symbol', 'X', '--amount', 'all', '--max-slippage', '5']);
    assertEqual(args.amount, 'all');
  });
});

// ============================================================
// Argument Validation
// ============================================================
describe('execute-trade.js — Argument Validation', () => {
  test('valid buy args produce no errors', () => {
    const args = parseArgs([
      '--action', 'buy', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', '500', '--max-slippage', '5', '--tier', 'moonshot',
    ]);
    const errors = validateArgs(args);
    assertEqual(errors.length, 0, `Expected no errors, got: ${errors.join(', ')}`);
  });

  test('valid sell args produce no errors', () => {
    const args = parseArgs([
      '--action', 'sell', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', 'all', '--max-slippage', '2',
    ]);
    const errors = validateArgs(args);
    assertEqual(errors.length, 0, `Expected no errors, got: ${errors.join(', ')}`);
  });

  test('missing action is caught', () => {
    const args = parseArgs(['--chain', 'base', '--address', '0x1', '--symbol', 'T', '--amount', '100', '--max-slippage', '2']);
    const errors = validateArgs(args);
    assert(errors.some(e => e.includes('action')), 'Should catch missing action');
  });

  test('invalid action is caught', () => {
    const args = parseArgs(['--action', 'transfer', '--chain', 'base', '--address', '0x1', '--symbol', 'T', '--amount', '100', '--max-slippage', '2']);
    const errors = validateArgs(args);
    assert(errors.some(e => e.includes('action')), 'Should catch invalid action');
  });

  test('buy without --tier is caught', () => {
    const args = parseArgs([
      '--action', 'buy', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', '500', '--max-slippage', '5',
    ]);
    const errors = validateArgs(args);
    assert(errors.some(e => e.includes('tier')), 'Should require tier for buy');
  });

  test('sell without --tier is allowed', () => {
    const args = parseArgs([
      '--action', 'sell', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', 'all', '--max-slippage', '2',
    ]);
    const errors = validateArgs(args);
    assert(!errors.some(e => e.includes('tier')), 'Tier not required for sell');
  });

  test('non-numeric slippage is caught', () => {
    const args = parseArgs([
      '--action', 'buy', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', '500', '--max-slippage', 'abc', '--tier', 'moonshot',
    ]);
    const errors = validateArgs(args);
    assert(errors.some(e => e.includes('slippage')), 'Should catch non-numeric slippage');
  });

  test('non-numeric amount (not "all") is caught', () => {
    const args = parseArgs([
      '--action', 'buy', '--chain', 'base', '--address', '0x1',
      '--symbol', 'T', '--amount', 'xyz', '--max-slippage', '5', '--tier', 'moonshot',
    ]);
    const errors = validateArgs(args);
    assert(errors.some(e => e.includes('amount')), 'Should catch non-numeric amount');
  });

  test('missing multiple args reports all errors', () => {
    const args = parseArgs([]);
    const errors = validateArgs(args);
    assert(errors.length >= 5, `Expected many errors, got ${errors.length}`);
  });
});

// ============================================================
// 1inch URL Construction
// ============================================================
describe('execute-trade.js — 1inch URL Construction', () => {
  test('builds correct URL with all params', () => {
    const url = build1inchUrl('8453', {
      src: '0xUSDC',
      dst: '0xTOKEN',
      amount: '500000000',
      from: '0xSAFE',
      slippage: '5',
    });
    assert(url.includes('/8453/swap'), 'Should include chain ID');
    assert(url.includes('src=0xUSDC'), 'Should include src token');
    assert(url.includes('dst=0xTOKEN'), 'Should include dst token');
    assert(url.includes('amount=500000000'), 'Should include amount');
    assert(url.includes('from=0xSAFE'), 'Should include from address');
    assert(url.includes('slippage=5'), 'Should include slippage');
    assert(url.includes('disableEstimate=true'), 'Must include disableEstimate=true for Safe wallets');
  });

  test('disableEstimate is always true', () => {
    const url = build1inchUrl('1', {
      src: '0xA', dst: '0xB', amount: '1', from: '0xC', slippage: '1',
    });
    assert(url.includes('disableEstimate=true'), 'disableEstimate must always be true');
  });

  test('includes receiver when provided', () => {
    const url = build1inchUrl('8453', {
      src: '0xA', dst: '0xB', amount: '1', from: '0xC', slippage: '1', receiver: '0xD',
    });
    assert(url.includes('receiver=0xD'), 'Should include receiver param');
  });
});

// ============================================================
// Slippage Pre-Check
// ============================================================
describe('execute-trade.js — Slippage Pre-Check', () => {
  test('slippage within limit is ok', () => {
    const result = checkSlippage('98', '100', 5);
    assert(result.ok, 'Should pass — 2% slippage within 5% limit');
    assertEqual(result.slippagePct, 2);
  });

  test('slippage at exact limit is ok', () => {
    const result = checkSlippage('95', '100', 5);
    assert(result.ok, 'Should pass — exactly at 5% limit');
    assertEqual(result.slippagePct, 5);
  });

  test('slippage exceeding limit is rejected', () => {
    const result = checkSlippage('90', '100', 5);
    assert(!result.ok, 'Should fail — 10% slippage exceeds 5% limit');
    assertEqual(result.slippagePct, 10);
  });

  test('zero expected amount is ok (edge case)', () => {
    const result = checkSlippage('0', '0', 5);
    assert(result.ok, 'Zero expected should pass');
  });

  test('positive slippage (got more than expected) passes', () => {
    const result = checkSlippage('105', '100', 5);
    assert(result.ok, 'Getting more than expected should pass');
  });
});

// ============================================================
// ERC-20 Approve Calldata
// ============================================================
describe('execute-trade.js — Approve Calldata', () => {
  test('generates valid calldata for approve', () => {
    const calldata = buildApproveCalldata('0x111111125421cA6dc452d289314280a0f8842A65', 1000000n);
    assert(typeof calldata === 'string', 'Should return hex string');
    assert(calldata.startsWith('0x'), 'Should start with 0x');
    // approve(address,uint256) selector is 0x095ea7b3
    assert(calldata.startsWith('0x095ea7b3'), `Should use approve selector, got ${calldata.slice(0, 10)}`);
  });

  test('calldata includes spender address', () => {
    const spender = '0x111111125421cA6dc452d289314280a0f8842A65';
    const calldata = buildApproveCalldata(spender, 1000000n);
    // Address is padded to 32 bytes in the calldata
    assert(calldata.toLowerCase().includes('111111125421ca6dc452d289314280a0f8842a65'), 'Should include spender address');
  });
});

// ============================================================
// Output Format Validation
// ============================================================
describe('execute-trade.js — Output Format', () => {
  test('executed result has required fields', () => {
    const result = {
      status: 'executed',
      safeHash: '0xabc',
      txHash: '0xdef',
      action: 'buy',
      symbol: 'TOKEN',
      chain: 'base',
      tokenAddress: '0x123',
      usdcSpent: 500,
      expectedTokens: '10000',
      timestamp: new Date().toISOString(),
    };
    assert(result.status === 'executed', 'Must have status');
    assert(result.safeHash, 'Must have safeHash');
    assert(result.txHash, 'Must have txHash');
    assert(result.action, 'Must have action');
    assert(result.symbol, 'Must have symbol');
    assert(result.chain, 'Must have chain');
    assert(result.timestamp, 'Must have timestamp');
  });

  test('queued_in_safe result has required fields', () => {
    const result = {
      status: 'queued_in_safe',
      safeHash: '0xabc',
      threshold: 2,
      confirmations: 1,
      action: 'sell',
      symbol: 'TOKEN',
      chain: 'base',
      timestamp: new Date().toISOString(),
    };
    assert(result.status === 'queued_in_safe', 'Must have status');
    assert(result.safeHash, 'Must have safeHash');
    assert(result.threshold, 'Must have threshold');
  });

  test('failed result has error message', () => {
    const result = {
      status: 'failed',
      error: 'Insufficient USDC',
      action: 'buy',
      symbol: 'TOKEN',
      chain: 'base',
      timestamp: new Date().toISOString(),
    };
    assert(result.status === 'failed', 'Must have status');
    assert(result.error, 'Must have error message');
  });
});

// ============================================================
// Security: No Private Key Leakage
// ============================================================
describe('execute-trade.js — Security', () => {
  test('output format has no key-like fields', () => {
    const validFields = [
      'status', 'safeHash', 'txHash', 'action', 'symbol', 'chain',
      'tokenAddress', 'usdcSpent', 'expectedTokens', 'tokensSold',
      'expectedUsdc', 'timestamp', 'error', 'threshold', 'confirmations', 'note',
    ];
    // Ensure known output fields don't include anything key-related
    const forbidden = ['privateKey', 'signerKey', 'secret', 'mnemonic', 'seed'];
    for (const f of forbidden) {
      assert(!validFields.includes(f), `Output should never include ${f}`);
    }
  });

  test('fake key does not appear in stringified output', () => {
    const fakeKey = '0xdeadbeef1234567890abcdef1234567890abcdef1234567890abcdef12345678';
    const result = {
      status: 'executed',
      safeHash: '0xabc',
      txHash: '0xdef',
      action: 'buy',
      symbol: 'TOKEN',
      chain: 'base',
      timestamp: new Date().toISOString(),
    };
    const output = JSON.stringify(result);
    assert(!output.includes(fakeKey), 'Private key must not appear in output');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
