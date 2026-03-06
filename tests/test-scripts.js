#!/usr/bin/env node
/**
 * Test Suite: Scripts
 *
 * Tests every data-fetching script to verify:
 * 1. Script runs without crashing
 * 2. Output is valid JSON
 * 3. Output has expected structure
 * 4. Error cases return proper error JSON (not stack traces)
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { describe, testAsync, assert, assertEqual, assertType, summary } from './test-helpers.js';

const SCRIPTS_DIR = resolve(process.cwd(), 'scripts');

function runScript(name, args = '') {
  try {
    const output = execSync(`node ${SCRIPTS_DIR}/${name} ${args}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      env: { ...process.env, NODE_ENV: 'test' },
    });
    return { success: true, output, parsed: JSON.parse(output) };
  } catch (err) {
    // Script might exit with code 1 but still produce valid JSON
    const output = err.stdout || err.stderr || '';
    try {
      return { success: false, output, parsed: JSON.parse(output) };
    } catch {
      return { success: false, output, parsed: null };
    }
  }
}

// ============================================================
// scan-tokens.js
// ============================================================
describe('scan-tokens.js', () => {
  testAsync('returns valid JSON with trending tokens', async () => {
    const result = runScript('scan-tokens.js', '--chain all --sort trending --limit 5');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertType(result.parsed.status, 'string', 'Must have status field');
    assert(result.parsed.timestamp, 'Must have timestamp');
    if (result.parsed.status === 'ok') {
      assert(Array.isArray(result.parsed.tokens), 'tokens must be array');
      assertEqual(result.parsed.sort, 'trending', 'sort should be trending');
    }
  });

  testAsync('respects --limit flag', async () => {
    const result = runScript('scan-tokens.js', '--chain all --sort trending --limit 3');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.tokens.length <= 3, 'Should not exceed limit');
    }
  });

  testAsync('token objects have required fields', async () => {
    const result = runScript('scan-tokens.js', '--chain all --sort trending --limit 1');
    if (result.parsed?.status === 'ok' && result.parsed.tokens.length > 0) {
      const token = result.parsed.tokens[0];
      assert(token.tokenAddress, 'Token must have tokenAddress');
      assert(token.chain, 'Token must have chain');
      assert(token.symbol, 'Token must have symbol');
      assertType(token.price, 'number', 'price must be number');
      assertType(token.liquidity, 'number', 'liquidity must be number');
    }
  });
});

// ============================================================
// token-metrics.js
// ============================================================
describe('token-metrics.js', () => {
  testAsync('errors gracefully without --address', async () => {
    const result = runScript('token-metrics.js', '');
    assert(!result.success || result.parsed?.status === 'error', 'Should error without address');
  });

  testAsync('returns structured data for known token (WETH)', async () => {
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const result = runScript('token-metrics.js', `--address ${weth} --chain ethereum`);
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.token, 'Must have token object');
      assert(result.parsed.metrics, 'Must have metrics object');
      assertType(result.parsed.metrics.price, 'number', 'price must be number');
      assertType(result.parsed.metrics.liquidity, 'number', 'liquidity must be number');
    }
  });

  testAsync('handles non-existent token gracefully', async () => {
    const result = runScript('token-metrics.js', '--address 0x0000000000000000000000000000000000000001 --chain ethereum');
    assert(result.parsed !== null, 'Must return JSON even for missing token');
    // Should return not_found or empty, not crash
  });
});

// ============================================================
// check-contract.js
// ============================================================
describe('check-contract.js', () => {
  testAsync('errors gracefully without required args', async () => {
    const result = runScript('check-contract.js', '');
    assert(!result.success, 'Should fail without address and chain');
  });

  testAsync('returns safety data for known token', async () => {
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const result = runScript('check-contract.js', `--address ${weth} --chain ethereum`);
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.safety, 'Must have safety object');
      assertType(result.parsed.safety.isHoneypot, 'boolean', 'isHoneypot must be boolean');
      assert(Array.isArray(result.parsed.flags), 'flags must be array');
      assertType(result.parsed.riskScore, 'number', 'riskScore must be number');
      assert(result.parsed.riskScore >= 0 && result.parsed.riskScore <= 100, 'riskScore must be 0-100');
      assert(result.parsed.verdict, 'Must have verdict');
    }
  });

  testAsync('rejects unsupported chain with proper error', async () => {
    const result = runScript('check-contract.js', '--address 0x123 --chain unsupported_chain');
    assert(result.parsed !== null, 'Must return JSON error');
    assertEqual(result.parsed?.status, 'error', 'Status should be error');
  });
});

// ============================================================
// check-positions.js
// ============================================================
describe('check-positions.js', () => {
  testAsync('returns ok with empty portfolio', async () => {
    const result = runScript('check-positions.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
    assert(Array.isArray(result.parsed.positions), 'positions must be array');
  });
});

// ============================================================
// check-liquidity.js
// ============================================================
describe('check-liquidity.js', () => {
  testAsync('returns ok when no tokens tracked', async () => {
    const result = runScript('check-liquidity.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
  });
});

// ============================================================
// check-wallets.js
// ============================================================
describe('check-wallets.js', () => {
  testAsync('returns ok with no tracked wallets', async () => {
    const result = runScript('check-wallets.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
  });

  testAsync('--list returns wallet array', async () => {
    const result = runScript('check-wallets.js', '--list');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assert(Array.isArray(result.parsed.wallets), 'wallets must be array');
  });
});

// ============================================================
// market-overview.js
// ============================================================
describe('market-overview.js', () => {
  testAsync('returns market data', async () => {
    const result = runScript('market-overview.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.market, 'Must have market object');
      assertType(result.parsed.market.totalMarketCap, 'number', 'totalMarketCap must be number');
      assertType(result.parsed.market.btcDominance, 'number', 'btcDominance must be number');
      assert(result.parsed.fearGreed, 'Must have fearGreed object');
    }
  });
});

// ============================================================
// portfolio-summary.js
// ============================================================
describe('portfolio-summary.js', () => {
  testAsync('returns ok with empty portfolio', async () => {
    const result = runScript('portfolio-summary.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
  });
});

// ============================================================
// narrative-check.js
// ============================================================
describe('narrative-check.js', () => {
  testAsync('returns narrative data for all narratives', async () => {
    const result = runScript('narrative-check.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(Array.isArray(result.parsed.narratives), 'narratives must be array');
      assert(result.parsed.narratives.length > 0, 'Should have at least one narrative');
      const n = result.parsed.narratives[0];
      assert(n.narrative, 'Narrative must have name');
      assert(n.momentum, 'Narrative must have momentum');
    }
  });

  testAsync('filters by specific narrative', async () => {
    const result = runScript('narrative-check.js', '--narrative ai');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assertEqual(result.parsed.narratives.length, 1, 'Should return exactly one narrative');
      assertEqual(result.parsed.narratives[0].narrative, 'ai', 'Should be ai narrative');
    }
  });
});

// ============================================================
// holder-distribution.js
// ============================================================
describe('holder-distribution.js', () => {
  testAsync('errors gracefully without required args', async () => {
    const result = runScript('holder-distribution.js', '');
    assert(!result.success, 'Should fail without address and chain');
  });

  testAsync('returns holder data for known token', async () => {
    const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
    const result = runScript('holder-distribution.js', `--address ${weth} --chain ethereum`);
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.concentration, 'Must have concentration object');
      assertType(result.parsed.concentration.top10, 'number', 'top10 must be number');
      assert(Array.isArray(result.parsed.topHolders), 'topHolders must be array');
    }
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
