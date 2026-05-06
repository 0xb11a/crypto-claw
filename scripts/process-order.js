#!/usr/bin/env node
/**
 * process-order.js — Deterministic order executor (no LLM required)
 *
 * Processes a single approved order: validate, execute, receipt, position, cash, mark done, alert.
 * Replaces the LLM-driven multi-step procedure with a single atomic script.
 *
 * Usage:
 *   node scripts/process-order.js --order-id <ID>
 *
 * Env vars: SAFE_ID, DB_PATH, PAPER_MODE, SAFE_SIGNER_KEY (real EVM),
 *           SQUADS_SIGNER_KEY (real Solana), TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *
 * Output: JSON to stdout with { ok, order_id, action, status, receipt_id, ... }
 * Always exits 0 — errors reported in JSON output.
 */

import 'dotenv/config';
import { getDb, close } from './db.js';
import { execSync, execFileSync } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { isSolana, getPortfolioRules, getTierMaxUsd, getQuarantineTokenAgeHours } from './chains.js';
import { log } from './log.js';
import { fetchOnchainCashBalance, evaluateCashDrift, evaluateReceivedDrift } from './onchain-balance.js';
import { fetchTwoSourceConfirmation, evaluateTwoSourceConfirmation } from './price-oracle.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const isPaper = process.env.PAPER_MODE === 'true';
const DEXSCREENER_BASE = 'https://api.dexscreener.com/latest/dex';
const STALE_PRICE_THRESHOLD = 0.1; // 10% drift = stale
const MAX_RETRIES = 5;
const TRANSIENT_ERRORS = ['Too Many Requests', '429', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'socket hang up'];

function plog(order, msg) {
  const tag = order ? `[${order.action} ${order.chain}/${order.symbol}] ` : '';
  const tail = order?.id ? ` (order ${order.id})` : '';
  log('info', 'process-order', `${tag}${msg}${tail}`);
}

// ============================================================
// CLI
// ============================================================

function getArg(name) {
  const idx = process.argv.indexOf(`--${name}`);
  return idx !== -1 && process.argv[idx + 1] ? process.argv[idx + 1] : null;
}

function uid(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================================
// Tier validation (PR 1.4)
//
// The orders.tier column has no CHECK constraint, so a poisoned
// proposal could write tier='stealth' / tier=null / tier='admin'.
// The legacy slippage selector at line ~171 falls back to 2% on any
// non-'moonshot' value, silently widening fills for forged tiers.
// We schema-validate at execution time against chains.js.
//
// Buys: tier required, must be in tiersEnabled for the chain.
// Sells: tier optional (sells inherit from position); reject if
// explicitly set to a value not in tiersEnabled.
// ============================================================

export function validateTier(tier, action, chain) {
  let allowedTiers;
  try {
    allowedTiers = getPortfolioRules(chain).tiersEnabled;
  } catch (err) {
    return { valid: false, reason: `invalid_tier: unknown chain '${chain}' (${err.message})` };
  }
  if (!Array.isArray(allowedTiers) || allowedTiers.length === 0) {
    return { valid: false, reason: `invalid_tier: chain '${chain}' has no tiersEnabled` };
  }
  if (action === 'buy') {
    if (!tier || !allowedTiers.includes(tier)) {
      return {
        valid: false,
        reason: `invalid_tier: '${tier ?? 'null'}' not in [${allowedTiers.join(', ')}] for chain ${chain}`,
      };
    }
  } else if (tier && !allowedTiers.includes(tier)) {
    return {
      valid: false,
      reason: `invalid_tier (${action}): '${tier}' not in [${allowedTiers.join(', ')}] for chain ${chain}`,
    };
  }
  return { valid: true };
}

// ============================================================
// Tier amount cap (PR 2.1)
//
// Defangs threat #5 (cash-balance poisoning). The legacy executor
// only checked `amount <= cash`. If portfolio_meta.cash_* is forged
// (via a prompt-injected agent or a sync bug) to e.g. $1M, then a
// "5% moonshot" order at $50,000 passes that check — and now the
// agent has just moved $50k to an attacker CA on a single trade.
//
// The absolute cap is operator-tunable (chains.js / env var). Sells
// are exempt: they exit existing positions whose size was already
// constrained at buy time.
// ============================================================

export function validateAmountCap(tier, action, amount, chain, env = process.env) {
  if (action !== 'buy') return { valid: true };
  const cap = getTierMaxUsd(chain, tier, env);
  if (cap === null) return { valid: true };
  const amt = parseFloat(amount);
  if (!Number.isFinite(amt) || amt <= 0) {
    return { valid: false, reason: `invalid_amount: '${amount}' is not a positive number` };
  }
  if (amt > cap) {
    return {
      valid: false,
      reason: `amount_over_tier_cap: $${amt} > $${cap} (tier=${tier}, chain=${chain})`,
    };
  }
  return { valid: true };
}

// ============================================================
// Token-age quarantine (PR 4.1)
//
// Real-mode buys for tokens younger than chains.js
// `quarantineTokenAgeHours` (default 24h) get refused with reason
// `quarantined_age` and an alert to the Research Telegram topic.
// The first 24h after listing is when rugpulls and post-launch
// contract upgrades cluster — forcing capital to wait eliminates
// the worst tier of moonshot losses.
//
// Operator can manually override via `db-query.js approve-order`
// after re-checking, OR can set QUARANTINE_TOKEN_AGE_HOURS=0 to
// disable the gate fund-wide.
//
// Skipped in paper mode (testing new tokens IS the point of paper).
// Skipped on missing pairCreatedAt (DEXScreener didn't return one
// → can't reason about age, fail open since the safety recheck
// already caught structural issues).
// ============================================================

/**
 * Pure age predicate, exported for offline tests.
 *
 * @param {object} input
 * @param {string|number|Date|null} input.pairCreatedAt  ISO string, epoch ms, or Date
 * @param {number} input.minAgeHours
 * @param {Date} [input.currentTime=now]
 * @returns {{ valid: boolean, ageHours: number|null, reason?: string }}
 */
export function evaluateTokenAge({ pairCreatedAt, minAgeHours, currentTime = new Date() }) {
  if (minAgeHours === null || minAgeHours === undefined || !Number.isFinite(minAgeHours) || minAgeHours <= 0) {
    return { valid: true, ageHours: null }; // gate disabled
  }
  if (pairCreatedAt === null || pairCreatedAt === undefined || pairCreatedAt === '') {
    // Fail open: PR 2.2 already handled the structural safety checks;
    // we don't have age info to reason about here.
    return { valid: true, ageHours: null };
  }
  let createdMs;
  if (pairCreatedAt instanceof Date) {
    createdMs = pairCreatedAt.getTime();
  } else if (typeof pairCreatedAt === 'number') {
    createdMs = pairCreatedAt;
  } else {
    const parsed = Date.parse(String(pairCreatedAt));
    if (!Number.isFinite(parsed)) return { valid: true, ageHours: null };
    createdMs = parsed;
  }
  const ageHours = (currentTime.getTime() - createdMs) / 3_600_000;
  if (!Number.isFinite(ageHours)) return { valid: true, ageHours: null };
  if (ageHours < 0) {
    // Future-dated → suspicious, treat as 0 age
    return {
      valid: false,
      ageHours,
      reason: `quarantined_age: pairCreatedAt is in the future (${ageHours.toFixed(1)}h) — likely bogus data`,
    };
  }
  if (ageHours < minAgeHours) {
    return {
      valid: false,
      ageHours,
      reason: `quarantined_age: token age ${ageHours.toFixed(1)}h < ${minAgeHours}h minimum`,
    };
  }
  return { valid: true, ageHours };
}

// ============================================================
// Data access helpers
// ============================================================

function loadOrder(db, orderId) {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
  if (!order) return { error: `Order not found: ${orderId}` };
  if (order.status !== 'approved') return { error: `Order status is '${order.status}', expected 'approved'` };
  if (order.take_profit_levels) {
    try {
      order.take_profit_levels_parsed = JSON.parse(order.take_profit_levels);
    } catch {
      order.take_profit_levels_parsed = [];
    }
  }
  return { order };
}

function isTransientError(errorMsg) {
  return TRANSIENT_ERRORS.some((pattern) => errorMsg.includes(pattern));
}

function getRetryCount(db, orderId) {
  const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(`retry_${orderId}`);
  return row ? parseInt(row.value, 10) : 0;
}

function setRetryCount(db, orderId, count) {
  db.prepare(
    "INSERT INTO portfolio_meta (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
  ).run(`retry_${orderId}`, String(count), String(count));
}

function clearRetryCount(db, orderId) {
  db.prepare('DELETE FROM portfolio_meta WHERE key = ?').run(`retry_${orderId}`);
}

function markRetry(db, orderId, reason, retryNum) {
  db.prepare(
    "UPDATE orders SET status_reason = ?, status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(`retry ${retryNum}/${MAX_RETRIES}: ${reason}`, orderId);
}

function getPosition(db, address, chain) {
  const table = isPaper ? 'paper_positions' : 'positions';
  return db
    .prepare(`SELECT * FROM ${table} WHERE address = ? AND chain = ? AND status IN ('open', 'partial_exit')`)
    .get(address, chain);
}

function getCash(db, chain) {
  const key = isPaper ? `paper_cash_${chain}` : `cash_${chain}`;
  const row = db.prepare('SELECT value FROM portfolio_meta WHERE key = ?').get(key);
  return row ? parseFloat(row.value || '0') : 0;
}

function setCash(db, chain, amount) {
  const key = isPaper ? `paper_cash_${chain}` : `cash_${chain}`;
  db.prepare("UPDATE portfolio_meta SET value = ?, updated_at = datetime('now') WHERE key = ?").run(
    String(amount),
    key,
  );
}

// ============================================================
// Pre-sign safety re-check (PR 2.2)
//
// Research validates the token at proposal time, but there's a delay
// between proposal → human approval → executor pickup. A token can:
//   - become a honeypot (admin enables blacklist after our buy queues)
//   - have its liquidity rugged
//   - have its top-holder concentration spike (deployer dumps to one
//     address, or multisig owner reclaims supply)
//
// We re-call check-contract.js + token-metrics.js immediately before
// signing. Hard-rejects: honeypot, transfer_pausable, top-holder>30%,
// liquidity<$5k. These mirror the agent-prose autoReject conditions
// in agents/research/AGENTS.md, but enforce them in code at the
// moment of value movement (defense in depth).
//
// Fail-closed: if either check throws or returns malformed JSON, we
// refuse to sign. Operator can bypass with SKIP_PRESIGN_RECHECK=true
// in genuine API outages.
// ============================================================

const RECHECK_MIN_LIQUIDITY_USD = 5_000;
const RECHECK_MAX_TOP_HOLDER_PCT = 30;

/**
 * Pure predicate — given the parsed JSON outputs of token-metrics
 * and check-contract, decide whether to allow the buy.
 *
 * Exported for offline unit tests so we don't need to spawn
 * subprocesses to test the decision logic.
 *
 * @param {object} input
 * @param {number|null} input.liquidity        from token-metrics
 * @param {object|null} input.safety           from check-contract
 * @param {number} [input.minLiquidity]
 * @param {number} [input.maxTopHolderPct]
 * @returns {{ valid: boolean, reason?: string }}
 */
export function evaluateRecheck({
  liquidity,
  safety,
  minLiquidity = RECHECK_MIN_LIQUIDITY_USD,
  maxTopHolderPct = RECHECK_MAX_TOP_HOLDER_PCT,
}) {
  // Fail-closed if either source is missing/malformed.
  if (liquidity === null || liquidity === undefined || !Number.isFinite(liquidity)) {
    return { valid: false, reason: 'recheck_failed: token-metrics returned no liquidity' };
  }
  if (!safety || typeof safety !== 'object') {
    return { valid: false, reason: 'recheck_failed: check-contract returned no safety object' };
  }

  if (liquidity < minLiquidity) {
    return {
      valid: false,
      reason: `liquidity_too_low_at_signing: $${liquidity.toFixed(0)} < $${minLiquidity}`,
    };
  }

  // check-contract.js sets these flags from GoPlus.
  if (safety.safety?.isHoneypot) {
    return { valid: false, reason: 'honeypot_detected_at_signing' };
  }
  if (safety.safety?.canPause) {
    return { valid: false, reason: 'pausable_detected_at_signing' };
  }

  // Top holder concentration. Excludes locked / contract holders so
  // legitimate liquidity locks (which often hold > 30%) don't false-
  // positive. The first non-contract, non-locked holder is the one
  // that could realistically dump.
  const holders = Array.isArray(safety.holders?.topHolders) ? safety.holders.topHolders : [];
  const topRealHolder = holders.find((h) => !h.isContract && !h.isLocked);
  if (topRealHolder) {
    const pct = parseFloat(topRealHolder.percent ?? 0);
    if (Number.isFinite(pct) && pct > maxTopHolderPct) {
      return {
        valid: false,
        reason: `top_holder_too_high_at_signing: ${pct.toFixed(1)}% > ${maxTopHolderPct}%`,
      };
    }
  }

  // check-contract may have its own autoReject (verdict='REJECT').
  // Honor it as a catch-all in case GoPlus added a critical flag we
  // don't explicitly check above.
  if (safety.autoReject || safety.verdict === 'REJECT') {
    const flags = Array.isArray(safety.flags) ? safety.flags : [];
    const critical = flags.find((f) => f.severity === 'critical');
    const reason = critical?.type ?? 'unknown_critical_flag';
    return { valid: false, reason: `autoReject_at_signing: ${reason}` };
  }

  return { valid: true };
}

/**
 * Orchestrates the two subprocess calls and returns the predicate
 * result. Errors from either spawn become recheck_failed reasons.
 *
 * PR 4.1: also returns `pairCreatedAt` (or null) so the caller can
 * apply the token-age quarantine without re-spawning token-metrics.
 *
 * @returns {{ valid: boolean, reason?: string, pairCreatedAt?: string|null }}
 */
function recheckBuySafety(address, chain) {
  let liquidity = null;
  let safety = null;
  let pairCreatedAt = null;

  // execFileSync with stdio:['ignore','pipe','pipe'] captures stderr separately
  // (execSync collapses it). On failure we surface the first 400 chars so the
  // operator can distinguish "tooling broken" (ENOENT, ETIMEDOUT, JSON parse)
  // from "contract unsafe" (legit reject from the script).
  const runRecheck = (scriptName) => {
    const scriptPath = resolve(__dirname, scriptName);
    return execFileSync('node', [scriptPath, '--address', address, '--chain', chain], {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  };
  const formatRecheckError = (scriptName, err) => {
    const stderr = (err.stderr || '').toString().trim();
    const message = err.message || '';
    log('error', 'process-order', `recheck ${scriptName} threw: ${message} | stderr=${stderr.slice(0, 600)}`);
    const detail = (stderr || message).slice(0, 400);
    return `recheck_failed: ${scriptName} threw (${detail})`;
  };

  try {
    const raw = runRecheck('token-metrics.js');
    const data = JSON.parse(raw);
    if (data.status === 'ok' && data.metrics) {
      liquidity = parseFloat(data.metrics.liquidity ?? 0);
      pairCreatedAt = data.metrics.pairCreatedAt ?? null;
    }
  } catch (err) {
    return { valid: false, reason: formatRecheckError('token-metrics', err) };
  }

  try {
    const raw = runRecheck('check-contract.js');
    safety = JSON.parse(raw);
  } catch (err) {
    return { valid: false, reason: formatRecheckError('check-contract', err) };
  }

  const result = evaluateRecheck({ liquidity, safety });
  return { ...result, pairCreatedAt };
}

// ============================================================
// Price fetching
// ============================================================

async function fetchCurrentPrice(address, chain) {
  // Try token-metrics.js first (more reliable)
  try {
    const scriptPath = resolve(__dirname, 'token-metrics.js');
    const raw = execSync(`node ${scriptPath} --address ${address} --chain ${chain}`, {
      encoding: 'utf-8',
      timeout: 30_000,
      cwd: __dirname,
    });
    const data = JSON.parse(raw);
    if (data.price > 0) return data.price;
  } catch {
    // fall through to DEXScreener
  }

  // Fallback: DEXScreener
  try {
    const res = await fetch(`${DEXSCREENER_BASE}/tokens/${address}`);
    if (!res.ok) return null;
    const data = await res.json();
    const pairs = data.pairs ?? [];
    const chainPairs = pairs.filter((p) => p.chainId === chain);
    const best = (chainPairs.length > 0 ? chainPairs : pairs).sort(
      (a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0),
    )[0];
    return best ? parseFloat(best.priceUsd ?? 0) : null;
  } catch {
    return null;
  }
}

// ============================================================
// Trade execution
// ============================================================

function executeTrade(order, action) {
  const scriptName = isSolana(order.chain) ? 'execute-trade-solana.js' : 'execute-trade-evm.js';
  const scriptPath = resolve(__dirname, scriptName);

  const args = [
    '--action',
    action,
    '--chain',
    order.chain,
    '--address',
    order.address,
    '--symbol',
    order.symbol,
    '--amount',
    String(order.amount),
    '--max-slippage',
    order.tier === 'moonshot' ? '5' : '2',
  ];
  if (action === 'buy' && order.tier) {
    args.push('--tier', order.tier);
  }

  plog(order, `spawn: ${scriptName} ${args.join(' ')}`);
  const start = Date.now();
  try {
    // execFileSync skips the /bin/sh hop. Previously execSync routed through
    // a shell, which would surface as "spawnSync /bin/sh ETIMEDOUT" instead
    // of the underlying child timeout — confusing classification and making
    // the receipt error message conflate "shell wrapper hung" with "child
    // process hung". Direct exec gives ETIMEDOUT without the shell prefix.
    const raw = execFileSync('node', [scriptPath, ...args], {
      encoding: 'utf-8',
      timeout: 120_000,
      env: process.env,
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const parsed = JSON.parse(raw);
    plog(
      order,
      `spawn returned status=${parsed.status} safeHash=${parsed.safeHash || ''} txHash=${parsed.txHash || parsed.txSignature || ''} error=${parsed.error || ''} (${Date.now() - start}ms)`,
    );
    return parsed;
  } catch (err) {
    // execute-trade-evm.js exits 1 on failure but still outputs JSON
    if (err.stdout) {
      try {
        const parsed = JSON.parse(err.stdout);
        plog(
          order,
          `spawn returned (non-zero exit) status=${parsed.status} error=${parsed.error || ''} (${Date.now() - start}ms)`,
        );
        return parsed;
      } catch {
        log(
          'error',
          'process-order',
          `[${order.action} ${order.chain}/${order.symbol}] spawn non-JSON stdout: ${String(err.stdout).slice(0, 500)} (order ${order.id})`,
        );
      }
    }
    log(
      'error',
      'process-order',
      `[${order.action} ${order.chain}/${order.symbol}] spawn crashed: ${err.message} (${Date.now() - start}ms) (order ${order.id})`,
    );
    return { status: 'failed', error: err.message || 'execute-trade crashed' };
  }
}

// ============================================================
// Receipt writing
// ============================================================

function writeReceipt(db, order, tradeResult, action, positionId) {
  const receiptId = uid('rcpt');
  if (isPaper) {
    db.prepare(
      `INSERT INTO paper_receipts (id, order_id, action, symbol, address, chain, tier, proposed_price, quantity, amount, pnl_percent, pnl_usd)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      order.id,
      action,
      order.symbol,
      order.address,
      order.chain,
      order.tier || null,
      tradeResult.proposedPrice || order.entry_price || 0,
      tradeResult.quantity || null,
      tradeResult.amount || null,
      tradeResult.pnlPercent || null,
      tradeResult.pnlUsd || null,
    );
  } else {
    db.prepare(
      `INSERT INTO receipts (id, order_id, action, symbol, address, chain, amount, quantity, expected_price, executed_price, slippage, status, safe_tx_hash, onchain_tx_hash, safe_nonce, error, position_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      receiptId,
      order.id,
      action,
      order.symbol,
      order.address,
      order.chain,
      tradeResult.amount || null,
      tradeResult.quantity || null,
      order.entry_price || null,
      tradeResult.executedPrice || tradeResult.price || null,
      tradeResult.slippage || null,
      tradeResult.status || 'executed',
      tradeResult.safeHash || null,
      tradeResult.txHash || tradeResult.txSignature || null,
      tradeResult.squadsTransactionIndex ?? tradeResult.safeNonce ?? null,
      tradeResult.error || null,
      positionId || null,
    );
  }
  return receiptId;
}

// ============================================================
// Order status updates
// ============================================================

function markExecuted(db, orderId) {
  db.prepare(
    "UPDATE orders SET status = 'executed', status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(orderId);
}

function markFailed(db, orderId, reason) {
  db.prepare(
    "UPDATE orders SET status = 'failed', status_reason = ?, status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(reason, orderId);
}

// Non-routable trades (no aggregator quote / insufficient liquidity) are not
// execution failures — the order never went on-chain and there's no point
// retrying. Using the existing 'cancelled' status keeps the schema unchanged
// while distinguishing them in queries via status_reason='no_route: ...'.
function markSkipped(db, orderId, reason) {
  db.prepare(
    "UPDATE orders SET status = 'cancelled', status_reason = ?, status_changed_at = datetime('now'), status_changed_by = 'executor' WHERE id = ?",
  ).run(reason, orderId);
}

// Detect aggregator no-route / insufficient-liquidity errors. These come
// through as 1inch "insufficient liquidity" / "cannot estimate" or Jupiter
// "No routes found" / "Could not find any route" messages.
function isNonRoutableError(errorMsg) {
  if (!errorMsg) return false;
  const m = String(errorMsg).toLowerCase();
  return (
    m.includes('no routes found') ||
    m.includes('insufficient liquidity') ||
    m.includes('could not find any route') ||
    m.includes('cannot estimate') ||
    m.includes('no route') ||
    m.includes('not enough liquidity')
  );
}

// ============================================================
// Alerts
// ============================================================

function sendAlert(type, message) {
  try {
    const scriptPath = resolve(__dirname, 'send-alert.js');
    execFileSync('node', [scriptPath, '--type', type, '--agent', 'executor', '--message', message], {
      encoding: 'utf-8',
      timeout: 10_000,
      cwd: __dirname,
    });
  } catch {
    // alerting should never block execution
  }
}

// ============================================================
// Portfolio sync (real mode only — reconcile on-chain balances)
// ============================================================

function syncPortfolio(chain) {
  if (isPaper) return; // paper mode has no on-chain state
  try {
    const scriptName = isSolana(chain) ? 'portfolio-load-solana.js' : 'portfolio-load-evm.js';
    const scriptPath = resolve(__dirname, scriptName);
    execSync(`node ${scriptPath} --chain ${chain} --trigger post_trade`, {
      encoding: 'utf-8',
      timeout: 60_000,
      cwd: __dirname,
    });
  } catch {
    // sync failure should never block order completion
  }
}

// ============================================================
// BUY processing
// ============================================================

async function processBuy(db, order) {
  const result = { ok: false, order_id: order.id, action: 'buy', symbol: order.symbol, chain: order.chain };
  plog(
    order,
    `order_loaded tier=${order.tier} amount=${order.amount} entry_price=${order.entry_price} stop_loss=${order.stop_loss} paper=${isPaper}`,
  );

  // 1. Validate cash
  const cash = getCash(db, order.chain);
  const amount = parseFloat(order.amount);
  if (cash < amount) {
    const reason = `insufficient_cash: have $${cash.toFixed(2)}, need $${amount}`;
    log(
      'error',
      'process-order',
      `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }
  plog(order, `cash_ok: have $${cash.toFixed(2)} need $${amount}`);

  // 1b. Pre-execute on-chain cash reconciliation (PR 2.4).
  // Defangs threat #5 directly. The DB's cash row could be poisoned —
  // reading the actual Safe/Squads vault balance and comparing is the
  // ground-truth check. Skipped in paper mode (no on-chain state) and
  // bypassable via SKIP_CASH_RECONCILE=true for genuine RPC outages.
  if (!isPaper && process.env.SKIP_CASH_RECONCILE !== 'true') {
    let onchainCash = null;
    try {
      onchainCash = await fetchOnchainCashBalance(order.chain);
    } catch (err) {
      const reason = `cash_reconcile_failed: ${String(err?.message || err).slice(0, 100)}`;
      log(
        'error',
        'process-order',
        `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
      markFailed(db, order.id, reason);
      sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
      return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
    }
    const drift = evaluateCashDrift({ dbCash: cash, onchainCash });
    if (!drift.valid) {
      log(
        'critical',
        'process-order',
        `BUY validation_failed: ${drift.reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: drift.reason }, 'buy');
      markFailed(db, order.id, drift.reason);
      sendAlert('trade_failed', `BUY $${order.symbol}: ${drift.reason}`);
      return { ...result, status: 'failed', error: drift.reason, receipt_id: receiptId };
    }
    plog(order, `cash_reconcile_ok onchain=$${onchainCash.toFixed(2)} drift=${drift.drift.toFixed(2)}%`);
  } else if (!isPaper) {
    plog(order, `cash_reconcile_skipped (SKIP_CASH_RECONCILE=true)`);
  }

  // 2. Validate price not stale
  const currentPrice = await fetchCurrentPrice(order.address, order.chain);
  plog(order, `price_fetched: current=${currentPrice} proposed=${order.entry_price}`);
  if (currentPrice && order.entry_price) {
    const drift = Math.abs(currentPrice - order.entry_price) / order.entry_price;
    if (drift > STALE_PRICE_THRESHOLD) {
      const reason = `stale_price: proposed $${order.entry_price}, current $${currentPrice} (${(drift * 100).toFixed(1)}% drift)`;
      log(
        'warn',
        'process-order',
        `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
      markFailed(db, order.id, reason);
      sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
      return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
    }
  }

  const execPrice = currentPrice || order.entry_price;
  if (currentPrice && order.entry_price) {
    const drift = Math.abs(currentPrice - order.entry_price) / order.entry_price;
    plog(order, `price_check_ok drift=${(drift * 100).toFixed(2)}% exec_price=$${execPrice}`);
  }

  // 2b. Pre-sign safety re-check (PR 2.2). Catches honeypots, paused
  // tokens, top-holder spikes, and liquidity rugs that happened
  // between proposal and execution. Operator can bypass with
  // SKIP_PRESIGN_RECHECK=true during a genuine API outage.
  let recheckPairCreatedAt = null;
  if (process.env.SKIP_PRESIGN_RECHECK !== 'true') {
    const recheck = recheckBuySafety(order.address, order.chain);
    if (!recheck.valid) {
      log(
        'error',
        'process-order',
        `BUY validation_failed: ${recheck.reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: recheck.reason }, 'buy');
      markFailed(db, order.id, recheck.reason);
      sendAlert('trade_failed', `BUY $${order.symbol}: ${recheck.reason}`);
      return { ...result, status: 'failed', error: recheck.reason, receipt_id: receiptId };
    }
    recheckPairCreatedAt = recheck.pairCreatedAt;
    plog(order, `presign_recheck_ok`);
  } else {
    plog(order, `presign_recheck_skipped (SKIP_PRESIGN_RECHECK=true)`);
  }

  // 2c. Token-age quarantine (PR 4.1). Real-mode buys for tokens
  // <quarantineTokenAgeHours (default 24h) get refused with
  // `quarantined_age` and surface in Telegram so the operator can
  // override. Skipped in paper mode (testing new tokens IS the point
  // of paper). Skipped if pairCreatedAt unavailable (the safety
  // recheck above already filtered structural issues).
  if (!isPaper && recheckPairCreatedAt) {
    const minAgeHours = getQuarantineTokenAgeHours(order.chain);
    const ageCheck = evaluateTokenAge({ pairCreatedAt: recheckPairCreatedAt, minAgeHours });
    if (!ageCheck.valid) {
      log(
        'warn',
        'process-order',
        `BUY quarantined: ${ageCheck.reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: ageCheck.reason }, 'buy');
      markFailed(db, order.id, ageCheck.reason);
      // Use trade_proposal so it lands in the Research topic — the
      // operator can re-evaluate and manually approve via the orders
      // skill if they want to override the quarantine.
      sendAlert(
        'trade_proposal',
        `🕒 BUY $${order.symbol} on ${order.chain} QUARANTINED — token age ${ageCheck.ageHours?.toFixed(1) ?? '?'}h < ${minAgeHours}h. Manually approve via 'approve-order ${order.id}' if you want to override.`,
      );
      return { ...result, status: 'quarantined', error: ageCheck.reason, receipt_id: receiptId };
    }
    plog(order, `quarantine_ok age=${ageCheck.ageHours?.toFixed(1)}h min=${minAgeHours}h`);
  }

  // 2d. Two-source confirmation (PR 4.2). Both DEXScreener AND
  // Birdeye must see the token (and agree on price within 2%) before
  // real money commits. Catches:
  //   - tokens only one source has indexed (suspicious for non-fresh
  //     tokens — fresh ones are already caught by PR 4.1 quarantine)
  //   - wash-trading that inflated price on one venue but not the
  //     other (the disagreement is the signal)
  // Skipped in paper mode and when SKIP_TWO_SOURCE_CONFIRM=true is
  // set (e.g. one of the APIs is rate-limited and the operator
  // accepts the risk to keep buys flowing).
  if (!isPaper && process.env.SKIP_TWO_SOURCE_CONFIRM !== 'true') {
    let twoSrc = null;
    try {
      twoSrc = await fetchTwoSourceConfirmation(order.chain, order.address);
    } catch (err) {
      // Don't fail the trade on a network blip — log and proceed. The
      // executor's other gates (oracle check inside execute-trade)
      // will fire if either source is genuinely unreachable.
      plog(order, `two_source_fetch_failed: ${err.message.slice(0, 80)} — skipping`);
      twoSrc = null;
    }
    if (twoSrc) {
      const conf = evaluateTwoSourceConfirmation(twoSrc);
      if (!conf.confirmed) {
        log(
          'warn',
          'process-order',
          `BUY quarantined: ${conf.reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
        );
        const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: conf.reason }, 'buy');
        markFailed(db, order.id, conf.reason);
        sendAlert(
          'trade_proposal',
          `🔀 BUY $${order.symbol} on ${order.chain} QUARANTINED — ${conf.reason}. Manually approve via 'approve-order ${order.id}' if you want to override.`,
        );
        return { ...result, status: 'quarantined', error: conf.reason, receipt_id: receiptId };
      }
      plog(order, `two_source_ok dex=${twoSrc.dex} birdeye=${twoSrc.birdeye} drift=${conf.driftPct?.toFixed(2)}%`);
    }
  }

  // 3. Validate we have a usable price
  if (!execPrice || execPrice <= 0) {
    const reason = 'no_price: could not determine execution price';
    log(
      'error',
      'process-order',
      `BUY validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  // 4. Execute
  let tradeResult;
  if (isPaper) {
    // Paper: simulate execution at current price
    const quantity = amount / execPrice;
    tradeResult = {
      status: 'executed',
      executedPrice: execPrice,
      quantity,
      amount,
      proposedPrice: order.entry_price,
    };
    plog(order, `paper_executed price=$${execPrice} quantity=${quantity}`);
  } else {
    plog(order, `execute invoking execute-trade for BUY amount=$${amount}`);
    tradeResult = executeTrade(order, 'buy');
  }

  // 5. Handle result
  if (tradeResult.status === 'failed') {
    const errorMsg = tradeResult.error || 'unknown';
    const reason = `tx_failed: ${errorMsg}`;

    // Non-routable: aggregator returned no route / insufficient liquidity.
    // The order never went on-chain — don't retry, don't mark failed (which
    // mixes with real execution failures), don't loud-alert. Cancel cleanly.
    if (isNonRoutableError(errorMsg)) {
      const skipReason = `no_route: ${errorMsg}`;
      log(
        'warn',
        'process-order',
        `BUY skipped (non-routable): ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed', error: skipReason }, 'buy');
      markSkipped(db, order.id, skipReason);
      sendAlert('trade_skipped', `BUY $${order.symbol} skipped: no aggregator route (${order.chain})`);
      return { ...result, status: 'skipped', error: skipReason, receipt_id: receiptId };
    }

    // Transient errors: keep order approved for retry on next heartbeat
    if (isTransientError(errorMsg)) {
      const retries = getRetryCount(db, order.id);
      if (retries < MAX_RETRIES) {
        setRetryCount(db, order.id, retries + 1);
        markRetry(db, order.id, errorMsg, retries + 1);
        log(
          'warn',
          'process-order',
          `BUY transient error: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
        );
        sendAlert('trade_retry', `BUY $${order.symbol}: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES}`);
        return { ...result, status: 'retry', error: reason, retry: retries + 1, max_retries: MAX_RETRIES };
      }
      log(
        'error',
        'process-order',
        `BUY retries exhausted: ${errorMsg} — ${MAX_RETRIES}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      clearRetryCount(db, order.id);
    } else {
      log(
        'error',
        'process-order',
        `BUY tx_failed: ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
    }

    const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed' }, 'buy');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `BUY $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  if (tradeResult.status === 'queued_in_safe' || tradeResult.status === 'queued_in_squads') {
    // Multisig needs more signatures — create draft position (committed but not yet confirmed)
    const positionId = uid('pos');
    const estPrice = tradeResult.executedPrice || execPrice;
    const estQty = tradeResult.quantity || (estPrice > 0 ? amount / estPrice : 0);
    db.prepare(
      `INSERT INTO positions (id, symbol, address, chain, tier, entry_price, current_price, quantity, value_usd, stop_loss, take_profit_levels, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft')`,
    ).run(
      positionId,
      order.symbol,
      order.address,
      order.chain,
      order.tier || 'moonshot',
      estPrice,
      estPrice,
      estQty,
      amount,
      order.stop_loss,
      order.take_profit_levels || '[]',
    );
    const receiptId = writeReceipt(db, order, tradeResult, 'buy', positionId);
    // Deduct cash — funds are committed to the multisig transaction
    setCash(db, order.chain, cash - amount);
    markExecuted(db, order.id);
    plog(
      order,
      `queued draft_position=${positionId} est_price=$${estPrice} est_qty=${estQty} cash $${cash.toFixed(2)}→$${(cash - amount).toFixed(2)} receipt=${receiptId}`,
    );
    sendAlert('trade_executed', `BUY $${order.symbol} queued (${tradeResult.status}) — draft position created`);
    return { ...result, ok: true, status: tradeResult.status, receipt_id: receiptId, position_id: positionId };
  }

  // Status: executed — write receipt, add position, update cash.
  // PR 2.6: prefer ACTUAL on-chain received qty over the quoted /
  // derived qty. Catches fee-on-transfer (1% transfer tax → 99
  // received vs 100 quoted) and partial honeypots (transfer tax in
  // one direction). Drift > maxSlippage + 0.5% fires a critical alert
  // and writes a marker into positions.notes so Sentinel sees it.
  const positionId = uid('pos');
  const maxSlippagePct = order.tier === 'moonshot' ? 5 : 2;
  const driftCheck =
    !isPaper && Number.isFinite(tradeResult.actualReceived) && Number.isFinite(tradeResult.quotedReceived)
      ? evaluateReceivedDrift({
          actualReceived: tradeResult.actualReceived,
          quotedReceived: tradeResult.quotedReceived,
          maxSlippagePct,
        })
      : null;
  const trustActual = driftCheck && Number.isFinite(tradeResult.actualReceived) && tradeResult.actualReceived > 0;
  const quantity = trustActual
    ? tradeResult.actualReceived
    : tradeResult.quantity || (execPrice > 0 ? amount / execPrice : 0);
  const finalPrice =
    trustActual && quantity > 0 ? amount / quantity : tradeResult.executedPrice || tradeResult.price || execPrice;
  const positionNotes =
    driftCheck && !driftCheck.valid
      ? `recv_drift_${driftCheck.driftPct.toFixed(2)}pct: ${driftCheck.reason} — possible fee-on-transfer or partial honeypot`
      : null;
  const posTable = isPaper ? 'paper_positions' : 'positions';

  db.prepare(
    `INSERT INTO ${posTable} (id, symbol, address, chain, tier, entry_price, current_price, quantity, value_usd, stop_loss, take_profit_levels, status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    positionId,
    order.symbol,
    order.address,
    order.chain,
    order.tier || 'moonshot',
    finalPrice,
    finalPrice,
    quantity,
    amount,
    order.stop_loss,
    order.take_profit_levels || '[]',
    positionNotes,
  );

  if (driftCheck && !driftCheck.valid) {
    log(
      'critical',
      'process-order',
      `BUY recv_drift exceeded slippage cap: ${driftCheck.reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol}, position: ${positionId})`,
    );
    sendAlert(
      'rug_warning',
      `BUY $${order.symbol}: received ${tradeResult.actualReceived} vs quoted ${tradeResult.quotedReceived} (${driftCheck.driftPct.toFixed(2)}% drift) — possible fee-on-transfer/honeypot. Position ${positionId} flagged.`,
    );
  } else if (driftCheck) {
    plog(
      order,
      `recv_drift_ok actual=${tradeResult.actualReceived} quoted=${tradeResult.quotedReceived} drift=${driftCheck.driftPct.toFixed(2)}%`,
    );
  }

  const receiptId = writeReceipt(db, order, tradeResult, 'buy', positionId);
  plog(order, `position_created id=${positionId} price=$${finalPrice} qty=${quantity} receipt=${receiptId}`);

  // Update cash
  const newCash = cash - amount;
  setCash(db, order.chain, newCash);
  plog(order, `cash_updated $${cash.toFixed(2)} → $${newCash.toFixed(2)}`);

  markExecuted(db, order.id);
  clearRetryCount(db, order.id);
  plog(
    order,
    `executed safeHash=${tradeResult.safeHash || ''} txHash=${tradeResult.txHash || tradeResult.txSignature || ''}`,
  );
  sendAlert('trade_executed', `BUY $${order.symbol} on ${order.chain} — $${amount} at $${finalPrice}`);
  syncPortfolio(order.chain);

  return {
    ...result,
    ok: true,
    status: 'executed',
    receipt_id: receiptId,
    position_id: positionId,
    executed_price: finalPrice,
    quantity,
    cash_after: parseFloat(newCash.toFixed(2)),
  };
}

// ============================================================
// SELL processing
// ============================================================

async function processSell(db, order) {
  const result = { ok: false, order_id: order.id, action: 'sell', symbol: order.symbol, chain: order.chain };
  plog(order, `order_loaded amount=${order.amount} reason=${order.reason || ''} paper=${isPaper}`);

  // 1. Validate position exists
  const position = getPosition(db, order.address, order.chain);
  if (!position) {
    const reason = 'no_position: no matching open position';
    log(
      'error',
      'process-order',
      `SELL validation_failed: ${reason} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
    );
    const receiptId = writeReceipt(db, order, { status: 'validation_failed', error: reason }, 'sell');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `SELL $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  plog(
    order,
    `position_found id=${position.id} qty=${position.quantity} entry=$${position.entry_price} tier=${position.tier}`,
  );

  // 2. Calculate sell quantity
  let sellQty = position.quantity;
  const amountStr = String(order.amount);
  if (amountStr !== 'all' && amountStr.endsWith('%')) {
    const pct = parseFloat(amountStr) / 100;
    sellQty = position.quantity * pct;
  }
  const isPartial = sellQty < position.quantity;
  plog(order, `sell_qty=${sellQty}/${position.quantity} partial=${isPartial}`);

  // 3. Execute
  let tradeResult;
  if (isPaper) {
    const currentPrice = await fetchCurrentPrice(order.address, order.chain);
    const exitPrice = currentPrice || position.current_price || position.entry_price;
    const saleProceeds = exitPrice * sellQty;
    const pnlUsd = (exitPrice - position.entry_price) * sellQty;
    const pnlPercent = position.entry_price > 0 ? ((exitPrice - position.entry_price) / position.entry_price) * 100 : 0;

    tradeResult = {
      status: 'executed',
      executedPrice: exitPrice,
      quantity: sellQty,
      amount: saleProceeds,
      proposedPrice: position.entry_price,
      pnlUsd: parseFloat(pnlUsd.toFixed(2)),
      pnlPercent: parseFloat(pnlPercent.toFixed(2)),
    };
    plog(
      order,
      `paper_executed price=$${exitPrice} proceeds=$${saleProceeds.toFixed(2)} pnl=${pnlPercent.toFixed(2)}%`,
    );
  } else {
    // Real mode: pass actual quantity for partial sells
    const sellOrder = { ...order, amount: isPartial ? String(sellQty) : 'all' };
    plog(order, `execute invoking execute-trade for SELL amount=${sellOrder.amount}`);
    tradeResult = executeTrade(sellOrder, 'sell');
  }

  // 4. Handle result
  if (tradeResult.status === 'failed') {
    const errorMsg = tradeResult.error || 'unknown';
    const reason = `tx_failed: ${errorMsg}`;

    // Non-routable: aggregator returned no route / insufficient liquidity.
    // For SELL this is operationally serious — the position can't auto-exit
    // and needs operator intervention — so we cancel the order (retrying
    // won't summon a route) but raise a loud alert. Skip the retry loop.
    if (isNonRoutableError(errorMsg)) {
      const skipReason = `no_route: ${errorMsg}`;
      log(
        'critical',
        'process-order',
        `SELL no_route — manual exit required: ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed', error: skipReason }, 'sell');
      markSkipped(db, order.id, skipReason);
      sendAlert(
        'trade_failed',
        `SELL $${order.symbol} BLOCKED: no aggregator route — manual exit required (${order.chain})`,
      );
      return { ...result, status: 'skipped', error: skipReason, receipt_id: receiptId };
    }

    // Transient errors: keep order approved for retry on next heartbeat
    if (isTransientError(errorMsg)) {
      const retries = getRetryCount(db, order.id);
      if (retries < MAX_RETRIES) {
        setRetryCount(db, order.id, retries + 1);
        markRetry(db, order.id, errorMsg, retries + 1);
        log(
          'warn',
          'process-order',
          `SELL transient error: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
        );
        sendAlert('trade_retry', `SELL $${order.symbol}: ${errorMsg} — retry ${retries + 1}/${MAX_RETRIES}`);
        return { ...result, status: 'retry', error: reason, retry: retries + 1, max_retries: MAX_RETRIES };
      }
      log(
        'error',
        'process-order',
        `SELL retries exhausted: ${errorMsg} — ${MAX_RETRIES}/${MAX_RETRIES} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
      clearRetryCount(db, order.id);
    } else {
      log(
        'error',
        'process-order',
        `SELL tx_failed: ${errorMsg} (order: ${order.id}, chain: ${order.chain}, symbol: ${order.symbol})`,
      );
    }

    const receiptId = writeReceipt(db, order, { ...tradeResult, status: 'tx_failed' }, 'sell');
    markFailed(db, order.id, reason);
    sendAlert('trade_failed', `SELL $${order.symbol}: ${reason}`);
    return { ...result, status: 'failed', error: reason, receipt_id: receiptId };
  }

  if (tradeResult.status === 'queued_in_safe' || tradeResult.status === 'queued_in_squads') {
    // Multisig needs more signatures — mark position as pending_exit
    db.prepare(`UPDATE positions SET status = 'pending_exit', updated_at = datetime('now') WHERE id = ?`).run(
      position.id,
    );
    const receiptId = writeReceipt(db, order, tradeResult, 'sell', position.id);
    markExecuted(db, order.id);
    plog(order, `queued position=${position.id} status=pending_exit receipt=${receiptId}`);
    sendAlert('trade_executed', `SELL $${order.symbol} queued (${tradeResult.status}) — pending confirmation`);
    return { ...result, ok: true, status: tradeResult.status, receipt_id: receiptId, position_id: position.id };
  }

  // Status: executed
  const exitPrice = tradeResult.executedPrice || tradeResult.price || position.current_price;
  const posTable = isPaper ? 'paper_positions' : 'positions';
  plog(order, `executing_settlement exit_price=$${exitPrice} partial=${isPartial}`);

  if (isPartial) {
    // Partial close: reduce quantity
    const remainQty = position.quantity - sellQty;
    db.prepare(
      `UPDATE ${posTable} SET quantity = ?, status = 'partial_exit', updated_at = datetime('now') WHERE id = ?`,
    ).run(remainQty, position.id);

    // Trailing stop activation after TP hits
    const reason = order.reason || '';
    if (reason === 'tp1_hit') {
      // After TP1: move SL to breakeven (entry price), record TP1 hit
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(1)) tpHit.push(1);
      db.prepare(
        `UPDATE ${posTable} SET stop_loss = ?, tp_levels_hit = ?, max_price_since_entry = COALESCE(max_price_since_entry, ?),
         updated_at = datetime('now') WHERE id = ?`,
      ).run(position.entry_price, JSON.stringify(tpHit), exitPrice, position.id);
    } else if (reason === 'tp2_hit') {
      // After TP2: activate trailing stop
      const trailPct = position.tier === 'moonshot' ? 30 : 20;
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(2)) tpHit.push(2);
      db.prepare(
        `UPDATE ${posTable} SET trailing_stop_pct = ?, trailing_stop_active = 1, tp_levels_hit = ?,
         max_price_since_entry = COALESCE(max_price_since_entry, ?), updated_at = datetime('now') WHERE id = ?`,
      ).run(trailPct, JSON.stringify(tpHit), exitPrice, position.id);
    } else if (reason === 'tp3_hit') {
      let tpHit = [];
      try {
        tpHit = position.tp_levels_hit ? JSON.parse(position.tp_levels_hit) : [];
      } catch {
        tpHit = [];
      }
      if (!tpHit.includes(3)) tpHit.push(3);
      db.prepare(`UPDATE ${posTable} SET tp_levels_hit = ?, updated_at = datetime('now') WHERE id = ?`).run(
        JSON.stringify(tpHit),
        position.id,
      );
    }
  } else {
    // Full close
    const pnlUsd = tradeResult.pnlUsd || (exitPrice - position.entry_price) * position.quantity;
    const pnlPercent =
      tradeResult.pnlPercent ||
      (position.entry_price > 0 ? ((exitPrice - position.entry_price) / position.entry_price) * 100 : 0);
    db.prepare(
      `UPDATE ${posTable} SET status = 'closed', exit_price = ?, exit_reason = ?, exit_date = date('now'),
       pnl_usd = ?, pnl_percent = ?, updated_at = datetime('now') WHERE id = ?`,
    ).run(exitPrice, order.reason || 'sell', pnlUsd, pnlPercent, position.id);
  }

  const receiptId = writeReceipt(db, order, tradeResult, 'sell', position.id);

  // Update cash after sell
  // - Paper mode: add sale proceeds directly (no on-chain state to sync)
  // - Real mode: do NOT update cash here. syncPortfolio() below refreshes
  //   cash from on-chain balances. If sync fails (silently caught), cash
  //   may be stale until the next scheduled portfolio sync or trade.
  if (isPaper) {
    const saleProceeds = tradeResult.amount || exitPrice * sellQty;
    const cash = getCash(db, order.chain);
    setCash(db, order.chain, cash + saleProceeds);
  }

  markExecuted(db, order.id);
  clearRetryCount(db, order.id);
  plog(
    order,
    `executed exit=$${exitPrice} qty=${sellQty} pnl_usd=${tradeResult.pnlUsd ?? ''} pnl_pct=${tradeResult.pnlPercent ?? ''} receipt=${receiptId} position=${position.id}`,
  );
  sendAlert('trade_executed', `SELL $${order.symbol} on ${order.chain} — ${amountStr} at $${exitPrice}`);
  syncPortfolio(order.chain);

  return {
    ...result,
    ok: true,
    status: 'executed',
    receipt_id: receiptId,
    position_id: position.id,
    executed_price: exitPrice,
    quantity: sellQty,
    pnl_usd: tradeResult.pnlUsd || null,
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const orderId = getArg('order-id');
  if (!orderId) {
    console.log(JSON.stringify({ ok: false, error: 'Missing --order-id' }));
    return;
  }

  const db = getDb();

  try {
    const { order, error } = loadOrder(db, orderId);
    if (error) {
      console.log(JSON.stringify({ ok: false, order_id: orderId, error }));
      return;
    }

    // PR 1.4: schema-validate tier before doing anything else.
    // Defangs threat #28 (tier-label forgery) — blocks invalid tiers
    // before they propagate to slippage selection or position writes.
    const tierCheck = validateTier(order.tier, order.action, order.chain);
    if (!tierCheck.valid) {
      log(
        'error',
        'process-order',
        `${order.action.toUpperCase()} validation_failed: ${tierCheck.reason} (order: ${orderId})`,
      );
      markFailed(db, orderId, tierCheck.reason);
      sendAlert('trade_failed', `${order.action.toUpperCase()} ${order.symbol}: ${tierCheck.reason}`);
      console.log(
        JSON.stringify({
          ok: false,
          order_id: orderId,
          status: 'failed',
          error: tierCheck.reason,
        }),
      );
      return;
    }

    // PR 2.1: tier-derived absolute USD cap.
    // Defangs threat #5 (cash-balance poisoning) — refuses any buy
    // larger than the per-tier ceiling regardless of what the cash
    // figure says. Cap is operator-tunable via TIER_MAX_USD_<TIER>.
    const capCheck = validateAmountCap(order.tier, order.action, order.amount, order.chain);
    if (!capCheck.valid) {
      log(
        'error',
        'process-order',
        `${order.action.toUpperCase()} validation_failed: ${capCheck.reason} (order: ${orderId})`,
      );
      markFailed(db, orderId, capCheck.reason);
      sendAlert('trade_failed', `${order.action.toUpperCase()} ${order.symbol}: ${capCheck.reason}`);
      console.log(
        JSON.stringify({
          ok: false,
          order_id: orderId,
          status: 'failed',
          error: capCheck.reason,
        }),
      );
      return;
    }

    // Real mode safety check
    if (!isPaper && !process.env.SAFE_SIGNER_KEY && !isSolana(order.chain)) {
      markFailed(db, orderId, 'no_signer_key');
      console.log(
        JSON.stringify({ ok: false, order_id: orderId, error: 'SAFE_SIGNER_KEY not set and not in paper mode' }),
      );
      return;
    }
    if (!isPaper && !process.env.SQUADS_SIGNER_KEY && isSolana(order.chain)) {
      markFailed(db, orderId, 'no_signer_key');
      console.log(
        JSON.stringify({ ok: false, order_id: orderId, error: 'SQUADS_SIGNER_KEY not set and not in paper mode' }),
      );
      return;
    }

    const result = order.action === 'buy' ? await processBuy(db, order) : await processSell(db, order);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    // Catch-all: mark failed and report
    log('critical', 'process-order', `crash: ${err.message} (order: ${orderId})`);
    try {
      markFailed(db, orderId, `crash: ${err.message}`);
    } catch {
      // DB might be unavailable
    }
    console.log(JSON.stringify({ ok: false, order_id: orderId, error: err.message }));
  } finally {
    close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
