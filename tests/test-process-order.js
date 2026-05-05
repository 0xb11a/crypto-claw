#!/usr/bin/env node
/**
 * Test Suite: Real Execution Pipeline (E2E)
 *
 * Tests the actual execution path for Base (Safe/1inch) and Solana (Squads/Jupiter).
 * Progressive stages — each validates prerequisites for the next:
 *
 *   Stage 1: Wallet status (read-only RPC calls)
 *   Stage 2: DEX quotes (read-only API calls)
 *   Stage 3: Dry-run execution (build + sign, NO broadcast)
 *   Stage 4: process-order.js integration (paper mode lifecycle)
 *   Stage 5: Live execution (only with --live flag, tiny $1 amounts)
 *
 * Usage:
 *   node tests/test-process-order.js           # Stages 1-4 (safe, no funds spent)
 *   node tests/test-process-order.js --live     # All stages including real execution
 *
 * Requires: .env with SAFE_ADDRESS_BASE, RPC_BASE, SAFE_SIGNER_KEY, ONEINCH_API_KEY,
 *           SQUADS_MULTISIG_ADDRESS, SQUADS_VAULT_ADDRESS, SQUADS_SIGNER_KEY, RPC_SOL
 */

import { execSync } from 'child_process';
import { resolve } from 'path';
import { readFileSync, unlinkSync } from 'fs';
import { describe, test, assert, assertEqual, summary } from './test-helpers.js';

const PROJECT_ROOT = resolve(new URL('.', import.meta.url).pathname, '..');

// Load .env manually (tests dir has no node_modules with dotenv)
try {
  const envFile = readFileSync(resolve(PROJECT_ROOT, '.env'), 'utf-8');
  for (const line of envFile.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      // Strip inline comments (only for unquoted values)
      const commentIdx = val.indexOf(' #');
      if (commentIdx !== -1) val = val.slice(0, commentIdx).trim();
    }
    if (!process.env[key]) process.env[key] = val;
  }
} catch {
  /* no .env file */
}
const SCRIPTS = resolve(PROJECT_ROOT, 'scripts');
const DB_QUERY = resolve(SCRIPTS, 'db-query.js');
const PROCESS_ORDER = resolve(SCRIPTS, 'process-order.js');
const SAFE_ID = `exec-test-${Date.now()}`;
const IS_LIVE = process.argv.includes('--live');

// Test tokens (BUY only)
const BASE_WETH = '0x4200000000000000000000000000000000000006';
const SOL_WSOL = 'So11111111111111111111111111111111111111112';

/** Run a script with .env loaded, return stdout */
function run(cmd, { timeout = 60_000 } = {}) {
  try {
    return execSync(cmd, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout,
      env: { ...process.env, SAFE_ID },
    }).trim();
  } catch (err) {
    // Capture output from failed commands — scripts output JSON even on failure
    const output = err.stdout?.trim() || '';
    const errOutput = err.stderr?.trim() || '';
    throw new Error(`Command failed: ${errOutput || output || err.message}`);
  }
}

/** Run a script and parse JSON output */
function runJson(cmd, opts = {}) {
  const raw = run(cmd, opts);
  const lines = raw.split('\n');
  const jsonStart = lines.findIndex((l) => l.startsWith('{') || l.startsWith('['));
  if (jsonStart === -1) throw new Error(`No JSON in output: ${raw.slice(0, 200)}`);
  return JSON.parse(lines.slice(jsonStart).join('\n'));
}

/** Run db-query.js command */
function dbq(command) {
  return runJson(`node ${DB_QUERY} ${command}`, {
    timeout: 10_000,
  });
}

/** Run process-order.js for an order */
function processOrder(orderId, { paperMode = true, envOverrides = {} } = {}) {
  const raw = execSync(`node ${PROCESS_ORDER} --order-id ${orderId}`, {
    encoding: 'utf-8',
    cwd: PROJECT_ROOT,
    timeout: 30_000,
    env: { ...process.env, SAFE_ID, PAPER_MODE: paperMode ? 'true' : 'false', ...envOverrides },
  }).trim();
  return JSON.parse(raw);
}

// Track test state across stages
const state = {
  baseStatus: null,
  solanaStatus: null,
  baseQuoteOk: false,
  solanaQuoteOk: false,
  baseDryRunOk: false,
  solanaDryRunOk: false,
};

// ============================================================
// Stage 1: Wallet Status (read-only)
// ============================================================
describe('Stage 1: Wallet Status — Base (Safe)', () => {
  test('connects to Base RPC and reads Safe status', () => {
    const result = runJson(`node ${SCRIPTS}/check-safe-status.js --chain base`);
    assert(result.status === 'ok', `Expected ok, got ${result.status}: ${result.error || ''}`);
    state.baseStatus = result;
  });

  test('Safe address is valid', () => {
    assert(state.baseStatus, 'Base status not available');
    assert(state.baseStatus.safe.address, 'Safe address missing');
    assert(state.baseStatus.safe.address.startsWith('0x'), 'Safe address must start with 0x');
  });

  test('Safe threshold is configured', () => {
    assert(state.baseStatus, 'Base status not available');
    assert(state.baseStatus.safe.threshold >= 1, `Threshold must be >= 1, got ${state.baseStatus.safe.threshold}`);
  });

  test('USDC balance is readable', () => {
    assert(state.baseStatus, 'Base status not available');
    const usdc = parseFloat(state.baseStatus.balances.usdc || '0');
    assert(!isNaN(usdc), 'USDC balance must be a number');
    console.log(`     Base Safe USDC: $${usdc.toFixed(2)}`);
  });
});

describe('Stage 1: Wallet Status — Solana (Squads)', () => {
  test('connects to Solana RPC and reads Squads status', () => {
    const result = runJson(`node ${SCRIPTS}/check-squads-status.js`);
    assert(result.status === 'ok', `Expected ok, got ${result.status}: ${result.error || ''}`);
    state.solanaStatus = result;
  });

  test('vault address is valid', () => {
    assert(state.solanaStatus, 'Solana status not available');
    assert(state.solanaStatus.vault.address, 'Vault address missing');
    assert(state.solanaStatus.vault.address.length >= 32, 'Vault address too short');
  });

  test('USDC balance is readable', () => {
    assert(state.solanaStatus, 'Solana status not available');
    const usdc = state.solanaStatus.vault.balances.usdc;
    assert(!isNaN(usdc), 'USDC balance must be a number');
    console.log(`     Squads Vault USDC: $${usdc.toFixed(2)}`);
  });

  test('SOL balance is readable', () => {
    assert(state.solanaStatus, 'Solana status not available');
    const sol = state.solanaStatus.vault.balances.sol;
    assert(!isNaN(sol), 'SOL balance must be a number');
    console.log(`     Squads Vault SOL: ${sol.toFixed(4)}`);
  });
});

// ============================================================
// Stage 2: DEX Quotes (read-only API calls)
// ============================================================
describe('Stage 2: DEX Quote — Base/1inch', () => {
  test('gets 1inch swap quote for USDC → WETH ($1)', () => {
    const usdcBase = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const amountWei = '1000000'; // $1 USDC = 1e6
    const chainId = '8453';
    const apiKey = process.env.ONEINCH_API_KEY;

    if (!apiKey) {
      console.log('     SKIP: ONEINCH_API_KEY not set');
      return;
    }

    const url =
      `https://api.1inch.dev/swap/v6.0/${chainId}/quote?` + `src=${usdcBase}&dst=${BASE_WETH}&amount=${amountWei}`;

    const raw = execSync(`curl -s -H "Authorization: Bearer ${apiKey}" "${url}"`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      timeout: 15_000,
    }).trim();

    const result = JSON.parse(raw);
    assert(result.dstAmount, `1inch quote must return dstAmount, got: ${JSON.stringify(result).slice(0, 200)}`);
    assert(BigInt(result.dstAmount) > 0n, 'Expected non-zero WETH amount');
    state.baseQuoteOk = true;
    console.log(`     1inch: $1 USDC → ${result.dstAmount} WETH wei`);
  });
});

describe('Stage 2: DEX Quote — Solana/Jupiter', () => {
  test('gets Jupiter swap quote for USDC → WSOL ($1)', () => {
    const usdcMint = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
    const amount = '1000000'; // $1 USDC = 1e6

    const url =
      `https://lite-api.jup.ag/swap/v1/quote?` +
      `inputMint=${usdcMint}&outputMint=${SOL_WSOL}&amount=${amount}&slippageBps=500`;

    const raw = execSync(`curl -s "${url}"`, {
      encoding: 'utf-8',
      timeout: 15_000,
    }).trim();

    const result = JSON.parse(raw);
    assert(result.outAmount, `Jupiter quote must return outAmount, got: ${JSON.stringify(result).slice(0, 200)}`);
    assert(parseInt(result.outAmount) > 0, 'Expected non-zero WSOL amount');
    state.solanaQuoteOk = true;
    console.log(`     Jupiter: $1 USDC → ${result.outAmount} WSOL lamports`);
  });
});

// ============================================================
// Stage 3: Dry-Run Execution (build + sign, NO broadcast)
// ============================================================
describe('Stage 3: Dry-Run — Base BUY (Safe/1inch)', () => {
  test('dry-run BUY WETH on Base — builds and signs Safe tx', () => {
    if (!state.baseQuoteOk) {
      console.log('     SKIP: 1inch quote failed in Stage 2');
      return;
    }
    const baseUsdc = parseFloat(state.baseStatus?.balances?.usdc || '0');
    if (baseUsdc < 1) {
      console.log(`     SKIP: Safe USDC balance ($${baseUsdc}) < $1`);
      return;
    }

    const result = runJson(
      `node ${SCRIPTS}/execute-trade-evm.js ` +
        `--action buy --chain base --address ${BASE_WETH} --symbol WETH ` +
        `--amount 1 --max-slippage 5 --tier moonshot --dry-run`,
      { timeout: 120_000 },
    );

    assertEqual(result.status, 'dry_run', `Expected dry_run status, got ${result.status}`);
    assert(result.safeHash, 'Must have safeHash');
    assert(result.signerAddress, 'Must have signerAddress');
    assert(result.signerAddress.startsWith('0x'), 'Signer address must be 0x-prefixed');
    assert(result.nonce >= 0, 'Must have valid nonce');
    assert(result.transactionCount >= 1, 'Must have at least 1 transaction (swap)');
    assertEqual(result.action, 'buy');
    assertEqual(result.chain, 'base');
    assertEqual(result.symbol, 'WETH');
    state.baseDryRunOk = true;
    console.log(`     Safe tx hash: ${result.safeHash}`);
    console.log(`     Signer: ${result.signerAddress}`);
    console.log(`     Tx count: ${result.transactionCount} (approve + swap)`);
  });
});

describe('Stage 3: Dry-Run — Solana BUY (Squads/Jupiter)', () => {
  test('dry-run BUY WSOL on Solana — builds and signs Squads tx', () => {
    if (!state.solanaQuoteOk) {
      console.log('     SKIP: Jupiter quote failed in Stage 2');
      return;
    }
    const solUsdc = state.solanaStatus?.vault?.balances?.usdc || 0;
    if (solUsdc < 1) {
      console.log(`     SKIP: Vault USDC balance ($${solUsdc}) < $1`);
      return;
    }

    const result = runJson(
      `node ${SCRIPTS}/execute-trade-solana.js ` +
        `--action buy --chain solana --address ${SOL_WSOL} --symbol WSOL ` +
        `--amount 1 --max-slippage 5 --tier moonshot --dry-run`,
      { timeout: 120_000 },
    );

    assertEqual(result.status, 'dry_run', `Expected dry_run status, got ${result.status}`);
    assert(result.squadsTransactionIndex > 0, 'Must have valid transaction index');
    assert(result.signerAddress, 'Must have signerAddress');
    assert(result.vaultAddress, 'Must have vaultAddress');
    assert(result.threshold >= 1, 'Must have valid threshold');
    assert(result.serializedTxLength > 0, 'Serialized tx must have length');
    assertEqual(result.action, 'buy');
    assertEqual(result.chain, 'solana');
    assertEqual(result.symbol, 'WSOL');
    state.solanaDryRunOk = true;
    console.log(`     Squads tx index: ${result.squadsTransactionIndex}`);
    console.log(`     Signer: ${result.signerAddress}`);
    console.log(`     Vault: ${result.vaultAddress}`);
    console.log(`     Threshold: ${result.threshold}`);
  });
});

// ============================================================
// Stage 4: process-order.js Integration (paper mode)
// ============================================================
describe('Stage 4: process-order.js — Paper Mode Lifecycle', () => {
  test('setup: migrate and seed cash', () => {
    dbq('migrate');
    dbq('set-cash --chain base --amount 10000');
    dbq('set-cash --chain solana --amount 5000');
    // Enable paper mode cash
    execSync(`node ${DB_QUERY} set-meta --key paper_cash_base --value 10000`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });
    execSync(`node ${DB_QUERY} set-meta --key paper_cash_solana --value 5000`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });
  });

  test('BUY on Base via process-order.js (paper)', () => {
    // Fetch current WETH price to avoid stale price rejection
    let wethPrice;
    try {
      const raw = execSync(`node ${SCRIPTS}/token-metrics.js --address ${BASE_WETH} --chain base`, {
        encoding: 'utf-8',
        cwd: PROJECT_ROOT,
        timeout: 30_000,
      });
      wethPrice = JSON.parse(raw).price;
    } catch {
      // Fallback: use 0 to skip stale check (process-order only checks if both prices exist)
      wethPrice = 0;
    }
    const entryPrice = wethPrice || 0;
    const stopLoss = entryPrice > 0 ? entryPrice * 0.7 : 1500;
    const takeProfit = entryPrice > 0 ? entryPrice * 1.5 : 4000;

    const order = {
      id: 'exec-test-buy-base',
      action: 'buy',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      address: BASE_WETH,
      chain: 'base',
      amount: 100,
      tier: 'conviction',
      entry_price: entryPrice,
      stop_loss: stopLoss,
      take_profit_levels: JSON.stringify([{ level: 1, price: takeProfit, sellPercent: 50 }]),
      analysis_score: 85,
      risk_score: 15,
      reasoning: 'Execution test',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(order)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    // PR 2.2: skip the new pre-sign recheck — this test verifies the
    // executor pipeline, not the GoPlus recheck (covered by the
    // offline test-presign-recheck suite). Avoids 30-60s of extra
    // latency and a hard dep on GoPlus availability for the test run.
    const result = processOrder('exec-test-buy-base', {
      paperMode: true,
      envOverrides: { SKIP_PRESIGN_RECHECK: 'true' },
    });
    assert(result.ok, `process-order must succeed: ${JSON.stringify(result)}`);
    assertEqual(result.status, 'executed', 'Must be executed');
    assertEqual(result.action, 'buy');
    assert(result.receipt_id, 'Must have receipt_id');
    assert(result.position_id, 'Must have position_id');
    console.log(`     BUY executed: position=${result.position_id}, price=$${result.executed_price}`);
  });

  test('BUY on Solana via process-order.js (paper)', () => {
    // Fetch current SOL price — WSOL is the native mint, DEXScreener may not find it directly
    // Use entry_price=0 to bypass stale check (process-order only checks if both prices exist)
    const order = {
      id: 'exec-test-buy-sol',
      action: 'buy',
      symbol: 'WSOL',
      name: 'Wrapped SOL',
      address: SOL_WSOL,
      chain: 'solana',
      amount: 50,
      tier: 'moonshot',
      entry_price: 0,
      stop_loss: 100,
      take_profit_levels: JSON.stringify([{ level: 1, price: 200, sellPercent: 50 }]),
      analysis_score: 78,
      risk_score: 20,
      reasoning: 'Execution test',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(order)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    // PR 2.2: same as the Base BUY test above — skip recheck here.
    const result = processOrder('exec-test-buy-sol', {
      paperMode: true,
      envOverrides: { SKIP_PRESIGN_RECHECK: 'true' },
    });
    assert(result.ok, `process-order must succeed: ${JSON.stringify(result)}`);
    assertEqual(result.status, 'executed');
    assertEqual(result.action, 'buy');
    assertEqual(result.chain, 'solana');
    console.log(`     BUY executed: position=${result.position_id}, price=$${result.executed_price}`);
  });

  test('cross-chain cash isolation', () => {
    // Verify Base cash reduced, Solana independent
    const baseCash = execSync(`node ${DB_QUERY} get-meta --key paper_cash_base`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    }).trim();
    const solCash = execSync(`node ${DB_QUERY} get-meta --key paper_cash_solana`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    }).trim();

    const baseParsed = JSON.parse(baseCash);
    const solParsed = JSON.parse(solCash);
    const baseVal = parseFloat(baseParsed.value);
    const solVal = parseFloat(solParsed.value);

    assert(baseVal < 10000, `Base cash should be reduced from $10000, got $${baseVal}`);
    assert(solVal < 5000, `Solana cash should be reduced from $5000, got $${solVal}`);
    console.log(`     Base cash: $${baseVal} (was $10,000)`);
    console.log(`     Solana cash: $${solVal} (was $5,000)`);
  });

  test('SELL on Base via process-order.js (paper)', () => {
    const sellOrder = {
      id: 'exec-test-sell-base',
      action: 'sell',
      symbol: 'WETH',
      address: BASE_WETH,
      chain: 'base',
      amount: 'all',
      reason: 'stop_loss',
      urgency: 'immediate',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(sellOrder)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    const result = processOrder('exec-test-sell-base', { paperMode: true });
    assert(result.ok, `process-order must succeed: ${JSON.stringify(result)}`);
    assertEqual(result.status, 'executed');
    assertEqual(result.action, 'sell');
    assert(result.position_id, 'Must have position_id');
    console.log(`     SELL executed: position=${result.position_id}, price=$${result.executed_price}`);
  });

  test('SELL partial on Solana via process-order.js (paper)', () => {
    const sellOrder = {
      id: 'exec-test-sell-sol-partial',
      action: 'sell',
      symbol: 'WSOL',
      address: SOL_WSOL,
      chain: 'solana',
      amount: '50%',
      reason: 'tp1_hit',
      urgency: 'immediate',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(sellOrder)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    const result = processOrder('exec-test-sell-sol-partial', { paperMode: true });
    assert(result.ok, `process-order must succeed: ${JSON.stringify(result)}`);
    assertEqual(result.status, 'executed');
    assertEqual(result.action, 'sell');
    console.log(`     Partial SELL: qty=${result.quantity}, price=$${result.executed_price}`);
  });

  test('validation: insufficient cash', () => {
    const order = {
      id: 'exec-test-nocash',
      action: 'buy',
      symbol: 'TEST',
      name: 'No Cash Token',
      address: '0xnocash',
      chain: 'base',
      amount: 999999,
      tier: 'moonshot',
      entry_price: 1,
      stop_loss: 0.5,
      take_profit_levels: '[]',
      analysis_score: 50,
      risk_score: 50,
      reasoning: 'Test insufficient cash',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(order)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    // PR 2.1's tier amount cap would normally block this $999,999 buy
    // before the cash check fires. Bump the moonshot cap above the
    // order amount so the cash check is what we're actually testing.
    const result = processOrder('exec-test-nocash', {
      paperMode: true,
      envOverrides: { TIER_MAX_USD_MOONSHOT: '10000000' },
    });
    assertEqual(result.ok, false, 'Should fail');
    assertEqual(result.status, 'failed');
    assert(result.error.includes('insufficient_cash'), `Error should mention insufficient_cash: ${result.error}`);
  });

  test('validation: sell with no matching position', () => {
    const sellOrder = {
      id: 'exec-test-nopos',
      action: 'sell',
      symbol: 'GHOST',
      address: '0xghost',
      chain: 'base',
      amount: 'all',
      reason: 'stop_loss',
    };
    execSync(`node ${DB_QUERY} add-order --json '${JSON.stringify(sellOrder)}'`, {
      encoding: 'utf-8',
      cwd: PROJECT_ROOT,
      env: { ...process.env, SAFE_ID, PAPER_MODE: 'true' },
      timeout: 10_000,
    });

    const result = processOrder('exec-test-nopos', { paperMode: true });
    assertEqual(result.ok, false, 'Should fail');
    assert(
      (result.status === 'failed' && result.error?.includes('no_position')) || result.error?.includes('no_position'),
      `Error should mention no_position: ${JSON.stringify(result)}`,
    );
  });

  test('validation: order not found', () => {
    const result = processOrder('nonexistent-order-id', { paperMode: true });
    assertEqual(result.ok, false, 'Should fail');
    assert(result.error.includes('not found'), `Error should mention not found: ${result.error}`);
  });
});

// ============================================================
// Stage 5: Live Execution (only with --live flag)
// ============================================================
if (IS_LIVE) {
  describe('Stage 5: LIVE Execution — Base BUY $1 WETH', () => {
    test('execute real BUY on Base (Safe/1inch)', () => {
      const baseUsdc = parseFloat(state.baseStatus?.balances?.usdc || '0');
      if (baseUsdc < 2) {
        console.log(`     SKIP: Safe USDC balance ($${baseUsdc}) < $2`);
        return;
      }

      const result = runJson(
        `node ${SCRIPTS}/execute-trade-evm.js ` +
          `--action buy --chain base --address ${BASE_WETH} --symbol WETH ` +
          `--amount 1 --max-slippage 5 --tier moonshot`,
        { timeout: 120_000 },
      );

      assert(
        ['executed', 'queued_in_safe'].includes(result.status),
        `Expected executed or queued_in_safe, got ${result.status}: ${result.error || ''}`,
      );
      console.log(`     Status: ${result.status}`);
      if (result.txHash) console.log(`     Tx hash: ${result.txHash}`);
      if (result.safeHash) console.log(`     Safe hash: ${result.safeHash}`);
    });
  });

  describe('Stage 5: LIVE Execution — Solana BUY $1 WSOL', () => {
    test('execute real BUY on Solana (Squads/Jupiter)', () => {
      const solUsdc = state.solanaStatus?.vault?.balances?.usdc || 0;
      if (solUsdc < 2) {
        console.log(`     SKIP: Vault USDC balance ($${solUsdc}) < $2`);
        return;
      }

      const result = runJson(
        `node ${SCRIPTS}/execute-trade-solana.js ` +
          `--action buy --chain solana --address ${SOL_WSOL} --symbol WSOL ` +
          `--amount 1 --max-slippage 5 --tier moonshot`,
        { timeout: 120_000 },
      );

      assert(
        ['executed', 'queued_in_squads'].includes(result.status),
        `Expected executed or queued_in_squads, got ${result.status}: ${result.error || ''}`,
      );
      console.log(`     Status: ${result.status}`);
      if (result.txSignature) console.log(`     Tx sig: ${result.txSignature}`);
    });
  });
} else {
  describe('Stage 5: Live Execution', () => {
    test('skipped (run with --live to enable)', () => {
      console.log('     Pass --live flag to execute real $1 trades on Base and Solana');
    });
  });
}

// ============================================================
// Cleanup
// ============================================================
describe('Cleanup', () => {
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
