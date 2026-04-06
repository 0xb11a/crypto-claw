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

  testAsync('returns valid JSON with established tokens', async () => {
    const result = runScript('scan-tokens.js', '--chain all --sort established --limit 5');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertType(result.parsed.status, 'string', 'Must have status field');
    assert(result.parsed.timestamp, 'Must have timestamp');
    if (result.parsed.status === 'ok') {
      assert(Array.isArray(result.parsed.tokens), 'tokens must be array');
      assertEqual(result.parsed.sort, 'established', 'sort should be established');
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
    const result = runScript(
      'token-metrics.js',
      '--address 0x0000000000000000000000000000000000000001 --chain ethereum',
    );
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
// check-contract.js --changes
// ============================================================
describe('check-contract.js --changes', () => {
  testAsync('returns ok when no open positions', async () => {
    const result = runScript('check-contract.js', '--changes');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
    assertEqual(result.parsed.tracked, 0, 'tracked should be 0 with no positions');
    assertEqual(result.parsed.alertCount, 0, 'alertCount should be 0');
    assert(Array.isArray(result.parsed.alerts), 'alerts must be array');
    assertType(result.parsed.positions, 'object', 'positions must be object');
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
  testAsync('returns ok when no open positions', async () => {
    const result = runScript('check-liquidity.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
    assertEqual(result.parsed.tracked, 0, 'tracked should be 0 with no positions');
    assertEqual(result.parsed.alertCount, 0, 'alertCount should be 0');
    assert(Array.isArray(result.parsed.alerts), 'alerts must be array');
  });

  testAsync('accepts --chain flag without error', async () => {
    const result = runScript('check-liquidity.js', '--chain base');
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
    assert(Array.isArray(result.parsed.wallets), 'wallets must be array');
    assertEqual(result.parsed.tracked, 0, 'tracked count should be 0');
  });

  testAsync('--positions returns ok with empty portfolio', async () => {
    const result = runScript('check-wallets.js', '--positions');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
    assert(Array.isArray(result.parsed.wallets), 'wallets must be array');
  });

  testAsync('--chain filters without error', async () => {
    const result = runScript('check-wallets.js', '--chain base');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
  });
});

// ============================================================
// score-wallet.js
// ============================================================
describe('score-wallet.js', () => {
  testAsync('errors gracefully without required args', async () => {
    const result = runScript('score-wallet.js', '');
    assert(!result.success, 'Should fail without address and chain');
  });

  testAsync('returns no_data when no API keys set', async () => {
    const result = runScript(
      'score-wallet.js',
      '--address 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045 --chain ethereum',
    );
    assert(result.parsed !== null, 'Output must be valid JSON');
    // Without API keys, should return no_data or ok
    assert(['no_data', 'ok', 'error'].includes(result.parsed.status), 'Status should be no_data, ok, or error');
    if (result.parsed.status === 'no_data') {
      assert(result.parsed.message, 'no_data should have a message');
    }
  });
});

// ============================================================
// score-wallets-bg.js
// ============================================================
describe('score-wallets-bg.js', () => {
  testAsync('returns valid JSON with expected fields', async () => {
    const result = runScript('score-wallets-bg.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.status, 'ok', 'Status should be ok');
    assertType(result.parsed.scored, 'number', 'scored must be number');
    assertType(result.parsed.failed, 'number', 'failed must be number');
    assertType(result.parsed.harvested, 'number', 'harvested must be number');
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
  testAsync('returns narrative data for all 26 narratives', async () => {
    const result = runScript('narrative-check.js');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(Array.isArray(result.parsed.narratives), 'narratives must be array');
      assert(result.parsed.narratives.length >= 26, 'Should have at least 26 narratives');
      assertType(result.parsed.narrativeCount, 'number', 'narrativeCount must be number');
      const n = result.parsed.narratives[0];
      assert(n.narrative, 'Narrative must have id');
      assert(n.narrativeName, 'Narrative must have name');
      assert(n.category, 'Narrative must have category');
      assert(n.tierAffinity, 'Narrative must have tierAffinity');
      assert(n.momentum, 'Narrative must have momentum');
      assert(Array.isArray(result.parsed.hottest), 'hottest must be array');
      assert(Array.isArray(result.parsed.warming), 'warming must be array');
      assert(Array.isArray(result.parsed.rotations), 'rotations must be array');
    }
  });

  testAsync('filters by specific narrative', async () => {
    const result = runScript('narrative-check.js', '--narrative ai_infra');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assertEqual(result.parsed.narratives.length, 1, 'Should return exactly one narrative');
      assertEqual(result.parsed.narratives[0].narrative, 'ai_infra', 'Should be ai_infra narrative');
    }
  });

  testAsync('rejects unknown narrative', async () => {
    const result = runScript('narrative-check.js', '--narrative nonexistent_xyz');
    assert(!result.success, 'Should fail for unknown narrative');
  });
});

// ============================================================
// narrative-deep-scan.js
// ============================================================
describe('narrative-deep-scan.js', () => {
  testAsync('errors without --narrative flag', async () => {
    const result = runScript('narrative-deep-scan.js', '');
    assert(!result.success, 'Should fail without --narrative');
  });

  testAsync('returns ranked tokens for single narrative (quick mode)', async () => {
    const result = runScript('narrative-deep-scan.js', '--narrative defi --quick');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assertEqual(result.parsed.narrative, 'defi', 'Should be defi narrative');
      assertEqual(result.parsed.mode, 'quick', 'Mode should be quick');
      assert(result.parsed.narrativeName, 'Must have narrativeName');
      assert(result.parsed.category, 'Must have category');
      assert(result.parsed.tierAffinity, 'Must have tierAffinity');
      assert(result.parsed.momentum, 'Must have momentum');
      assertType(result.parsed.candidatesFound, 'number', 'candidatesFound must be number');
      assert(Array.isArray(result.parsed.tokens), 'tokens must be array');
      assert(result.parsed.tokens.length <= 3, 'Quick mode should return max 3 tokens');
      if (result.parsed.tokens.length > 0) {
        const t = result.parsed.tokens[0];
        assertEqual(t.rank, 1, 'First token rank should be 1');
        assert(t.address, 'Token must have address');
        assert(t.chain, 'Token must have chain');
        assert(t.symbol, 'Token must have symbol');
        assertType(t.score, 'number', 'score must be number');
        assert(t.suggestedTier, 'Token must have suggestedTier');
        assert(['moonshot', 'conviction'].includes(t.suggestedTier), 'suggestedTier must be moonshot or conviction');
      }
    }
  });

  testAsync('respects --limit flag', async () => {
    const result = runScript('narrative-deep-scan.js', '--narrative memecoin --quick --limit 1');
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.tokens.length <= 1, 'Should not exceed limit of 1');
    }
  });

  testAsync('rejects unknown narrative', async () => {
    const result = runScript('narrative-deep-scan.js', '--narrative nonexistent_xyz');
    assert(!result.success, 'Should fail for unknown narrative');
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
// heartbeat-check.js
// ============================================================
describe('heartbeat-check.js', () => {
  testAsync('errors without --agent flag', async () => {
    const result = runScript('heartbeat-check.js', '');
    assert(!result.success, 'Should fail without --agent');
  });

  testAsync('executor skips on empty DB', async () => {
    const result = runScript('heartbeat-check.js', '--agent executor');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.agent, 'executor', 'agent should be executor');
    assertEqual(result.parsed.skip, true, 'Should skip with no pending orders');
    assert(result.parsed.reason, 'Should have a reason when skipping');
  });

  testAsync('sentinel skips on empty DB', async () => {
    const result = runScript('heartbeat-check.js', '--agent sentinel');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.agent, 'sentinel', 'agent should be sentinel');
    assertEqual(result.parsed.skip, true, 'Should skip with no open positions');
    assert(result.parsed.reason, 'Should have a reason when skipping');
  });

  testAsync('executor detects pending sell order', async () => {
    // Add a pending sell order, then check
    const addResult = runScript(
      'db-query.js',
      `add-order --json '${JSON.stringify({
        id: 'test-sell-hb',
        action: 'sell',
        symbol: 'TEST',
        address: '0xtest',
        chain: 'base',
        amount: 'all',
        reason: 'stop_loss',
        urgency: 'immediate',
      })}'`,
    );
    assert(addResult.parsed?.ok, 'Should add sell order');

    const result = runScript('heartbeat-check.js', '--agent executor');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertEqual(result.parsed.agent, 'executor', 'agent should be executor');
    assertEqual(result.parsed.skip, false, 'Should not skip with pending sell order');
    assert(result.parsed.pending_sells > 0, 'Should report pending sells');

    // Clean up: mark as executed
    runScript('db-query.js', 'mark-order-executed --id test-sell-hb');
  });

  testAsync('sentinel detects open paper position', async () => {
    // Add an open paper position, then check with PAPER_MODE
    const addResult = runScript(
      'db-query.js',
      `add-paper-position --json '${JSON.stringify({
        id: 'test-pp-hb',
        symbol: 'TEST',
        address: '0xtest',
        chain: 'base',
        tier: 'moonshot',
        entry_price: 0.001,
        current_price: 0.001,
        quantity: 1000,
        value_usd: 1,
        stop_loss: 0.0005,
        take_profit_levels: [{ level: 1, price: 0.002, sellPercent: 50 }],
      })}'`,
    );
    assert(addResult.parsed?.ok, 'Should add paper position');

    // Run heartbeat-check with PAPER_MODE=true
    try {
      const output = execSync(`node ${SCRIPTS_DIR}/heartbeat-check.js --agent sentinel`, {
        encoding: 'utf-8',
        timeout: 10_000,
        env: { ...process.env, NODE_ENV: 'test', PAPER_MODE: 'true' },
      });
      const parsed = JSON.parse(output);
      assertEqual(parsed.agent, 'sentinel', 'agent should be sentinel');
      assertEqual(parsed.skip, false, 'Should not skip with open paper position');
      assert(parsed.open_positions > 0, 'Should report open positions');
    } catch (err) {
      const output = err.stdout || '';
      assert(false, `heartbeat-check sentinel failed: ${output}`);
    }

    // Clean up
    runScript(
      'db-query.js',
      `close-paper-position --id test-pp-hb --json '${JSON.stringify({ exit_price: 0.001, exit_reason: 'test_cleanup' })}'`,
    );
  });

  testAsync('rejects invalid agent name', async () => {
    const result = runScript('heartbeat-check.js', '--agent invalid');
    assert(!result.success, 'Should fail with invalid agent name');
  });
});

// ============================================================
// scan-tokens.js — Solana chain
// ============================================================
describe('scan-tokens.js — Solana', () => {
  testAsync('returns valid JSON for Solana trending tokens', async () => {
    const result = runScript('scan-tokens.js', '--chain solana --sort trending --limit 5');
    assert(result.parsed !== null, 'Output must be valid JSON');
    assertType(result.parsed.status, 'string', 'Must have status field');
    assert(result.parsed.timestamp, 'Must have timestamp');
    if (result.parsed.status === 'ok') {
      assert(Array.isArray(result.parsed.tokens), 'tokens must be array');
    }
  });
});

// ============================================================
// check-contract.js — Solana
// ============================================================
describe('check-contract.js — Solana', () => {
  testAsync('returns parsed safety data for Solana token', async () => {
    // BONK — well-known Solana token
    const bonk = 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263';
    const result = runScript('check-contract.js', `--address ${bonk} --chain solana`);
    assert(result.parsed !== null, 'Output must be valid JSON');
    if (result.parsed?.status === 'ok') {
      assert(result.parsed.safety, 'Must have safety object (not raw GoPlus)');
      assert(Array.isArray(result.parsed.flags), 'flags must be array');
      assertType(result.parsed.riskScore, 'number', 'riskScore must be number');
      assert(result.parsed.riskScore >= 0 && result.parsed.riskScore <= 100, 'riskScore must be 0-100');
      assert(result.parsed.verdict, 'Must have verdict');
      assertEqual(result.parsed.chain, 'solana', 'chain should be solana');
    }
  });
});

// ============================================================
// portfolio-load-solana.js
// ============================================================
describe('portfolio-load-solana.js', () => {
  testAsync('returns proper error JSON without env vars', async () => {
    const result = runScript('portfolio-load-solana.js', '--chain solana');
    assert(result.parsed !== null, 'Must return JSON (not crash)');
    // Without SQUADS_VAULT_ADDRESS or SQUADS_MULTISIG_ADDRESS, should return error
    assertEqual(result.parsed?.status, 'error', 'Should return error without env vars');
  });
});

// ============================================================
// check-squads-status.js
// ============================================================
describe('check-squads-status.js', () => {
  testAsync('returns proper error JSON without env vars', async () => {
    const result = runScript('check-squads-status.js');
    assert(result.parsed !== null, 'Must return JSON (not crash)');
    assertEqual(result.parsed?.status, 'error', 'Should return error without env vars');
  });
});

// ============================================================
// db-query.js — Chain Discovery Commands
// ============================================================

describe('db-query.js get-chains', () => {
  testAsync('returns active and all chain lists', async () => {
    const result = runScript('db-query.js', 'get-chains');
    assert(result.success, 'get-chains should succeed');
    assert(Array.isArray(result.parsed?.active), 'active should be an array');
    assert(Array.isArray(result.parsed?.all), 'all should be an array');
    assert(result.parsed.active.length > 0, 'active should have at least one chain');
    assert(result.parsed.all.length > 0, 'all should have at least one chain');
    assert(result.parsed.all.includes('base'), 'all should include base');
    assert(result.parsed.all.includes('ethereum'), 'all should include ethereum');
    assert(result.parsed.all.includes('solana'), 'all should include solana');
  });
});

describe('db-query.js get-chain-config', () => {
  testAsync('returns full config for base chain', async () => {
    const result = runScript('db-query.js', 'get-chain-config --chain base');
    assert(result.success, 'get-chain-config should succeed');
    assertEqual(result.parsed?.name, 'base');
    assertEqual(result.parsed?.type, 'evm');
    assertEqual(result.parsed?.chainId, '8453');
    assertEqual(result.parsed?.dex, '1inch');
    assert(result.parsed?.cashToken, 'Should have cashToken');
    assertEqual(result.parsed?.cashToken?.symbol, 'USDC');
    assert(Array.isArray(result.parsed?.baseTierTokens), 'baseTierTokens should be array');
    assert(result.parsed.baseTierTokens.length > 0, 'Should have base tier tokens');
    assert(result.parsed?.rules, 'Should have rules');
    assertEqual(result.parsed?.rules?.maxMoonshotPosition, 5);
  });

  testAsync('returns baseTierTokens with correct structure', async () => {
    const result = runScript('db-query.js', 'get-chain-config --chain ethereum');
    assert(result.success, 'get-chain-config should succeed');
    const tokens = result.parsed?.baseTierTokens;
    assert(Array.isArray(tokens), 'baseTierTokens should be array');
    assert(tokens.length >= 2, 'Ethereum should have WETH + WBTC');
    assert(tokens[0].symbol, 'Token should have symbol');
    assert(tokens[0].address, 'Token should have address');
    assert(typeof tokens[0].decimals === 'number', 'Token should have numeric decimals');
  });

  testAsync('errors without --chain flag', async () => {
    const result = runScript('db-query.js', 'get-chain-config');
    assert(!result.success, 'Should fail without --chain');
  });

  testAsync('errors for unknown chain', async () => {
    const result = runScript('db-query.js', 'get-chain-config --chain polygon');
    assert(!result.success, 'Should fail for unknown chain');
  });
});

// ============================================================
// Results
// ============================================================
const allPassed = summary();
process.exit(allPassed ? 0 : 1);
