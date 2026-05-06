#!/usr/bin/env node
/**
 * execute-trade-evm.js — Build, sign, and submit Safe wallet swap transactions
 *
 * Usage:
 *   node scripts/execute-trade-evm.js \
 *     --action buy|sell --chain base --address 0x... --symbol TOKEN \
 *     --amount 500 --max-slippage 5 --tier moonshot --deadline 300
 *
 * BUY: USDC → Token (amount is USD value)
 * SELL: Token → USDC (amount is "all" or token quantity)
 *
 * Output: JSON with status "executed", "queued_in_safe", or "failed"
 */

import 'dotenv/config';
import { getChain, getCashToken, isAllowedRouter, isAllowedRpcUrl } from './chains.js';
import { fetchOraclePrice, evaluatePriceDrift } from './price-oracle.js';
import { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, parseUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import SafeModule from '@safe-global/protocol-kit';
import SafeApiKitModule from '@safe-global/api-kit';
const Safe = SafeModule.default || SafeModule;
const SafeApiKit = SafeApiKitModule.default || SafeApiKitModule;
import { log } from './log.js';

// ============================================================
// Logging helpers
// ============================================================

const shortAddr = (a) => (a ? `${a.slice(0, 6)}...${a.slice(-4)}` : '');

function stepLog(ctx, msg) {
  const tag = ctx ? `[${ctx.action} ${ctx.chain}/${ctx.symbol}] ` : '';
  log('info', 'execute-trade-evm', `${tag}${msg}`);
}

function is429(err) {
  const status = err?.status || err?.response?.status || err?.code;
  if (status === 429) return true;
  const msg = String(err?.message || '');
  return msg.includes('Too Many Requests') || msg.includes('429');
}

// Walk the err / err.cause chain and pull the deepest available HTTP status +
// body. The Safe SDK wraps fetch errors in custom Error subclasses, and
// 422 "Unprocessable Content" responses bury the validation body two levels
// deep. Without this, the operator sees only "proposeTransaction: Unprocessable
// Content" with no actionable detail.
function extractHttpDetail(err) {
  let status = '';
  let body = '';
  let cur = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    status =
      status || cur.status || cur.statusCode || cur.response?.status || cur.response?.statusCode || cur.code || '';
    const candidate = cur.response?.data ?? cur.response?.body ?? cur.data ?? cur.body ?? '';
    if (candidate && !body) {
      body = typeof candidate === 'string' ? candidate : JSON.stringify(candidate);
    }
    cur = cur.cause;
  }
  return { status, body };
}

async function withStep(label, ctx, fn, { retries = 0, baseDelay = 1000 } = {}) {
  const start = Date.now();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (is429(err) && attempt < retries) {
        const delay = baseDelay * Math.pow(2, attempt);
        stepLog(ctx, `${label} 429 retry ${attempt + 1}/${retries + 1} backoff=${delay}ms`);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
      const { status, body } = extractHttpDetail(err);
      const detailParts = [status ? `HTTP ${status}` : '', body ? body.slice(0, 800) : ''].filter(Boolean);
      const detail = detailParts.length ? ` [${detailParts.join(' ')}]` : '';
      const msg = `${label}: ${err.message}${detail}`;
      stepLog(ctx, `ERROR ${msg} (${Date.now() - start}ms)`);
      const wrapped = new Error(msg);
      wrapped.cause = err;
      throw wrapped;
    }
  }
}

// Each Safe API call gets exponential backoff up to ~3.2 min total
// (1.5+3+6+12+24+48+96 = 190.5s) so a single spawn absorbs a full Safe
// Transaction Service rate-limit window without escalating to retry-at-the-
// order-level. Combined with the order-level retry loop in process-order.js
// this gives a ~16 min absorption window before an order is marked failed.
const SAFE_RETRY = { retries: 7, baseDelay: 1500 };

// ============================================================
// Constants
// ============================================================

// USDC address resolved per-chain from chains.js in resolveConfig()

const ONEINCH_ROUTER = '0x111111125421cA6dc452d289314280a0f8842A65';
const ONEINCH_BASE_URL = 'https://api.1inch.dev/swap/v6.0';

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
]);

// ============================================================
// Argument Parsing
// ============================================================

export function parseArgs(argv) {
  const args = argv || process.argv.slice(2);
  const config = {
    action: '',
    chain: '',
    address: '',
    symbol: '',
    amount: '',
    maxSlippage: '',
    tier: '',
    deadline: '300',
    dryRun: false,
  };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dry-run') {
      config.dryRun = true;
      continue;
    }
    switch (args[i]) {
      case '--action':
        config.action = args[++i];
        break;
      case '--chain':
        config.chain = args[++i];
        break;
      case '--address':
        config.address = args[++i];
        break;
      case '--symbol':
        config.symbol = args[++i];
        break;
      case '--amount':
        config.amount = args[++i];
        break;
      case '--max-slippage':
        config.maxSlippage = args[++i];
        break;
      case '--tier':
        config.tier = args[++i];
        break;
      case '--deadline':
        config.deadline = args[++i];
        break;
    }
  }
  return config;
}

export function validateArgs(config) {
  const errors = [];
  if (!['buy', 'sell'].includes(config.action)) errors.push('--action must be "buy" or "sell"');
  if (!config.chain) errors.push('--chain is required');
  if (!config.address) errors.push('--address is required');
  if (!config.symbol) errors.push('--symbol is required');
  if (!config.amount) errors.push('--amount is required');
  if (!config.maxSlippage) errors.push('--max-slippage is required');
  if (config.action === 'buy' && !config.tier) errors.push('--tier is required for buy');

  if (config.maxSlippage && isNaN(parseFloat(config.maxSlippage))) {
    errors.push('--max-slippage must be a number');
  }
  if (config.amount && config.amount !== 'all' && isNaN(parseFloat(config.amount))) {
    errors.push('--amount must be a number or "all"');
  }

  return errors;
}

// ============================================================
// Chain / Env Resolution
// ============================================================

function resolveConfig(chainName) {
  const chain = getChain(chainName);
  const safeAddress = process.env[chain.safe.addressEnv];
  const rpcUrl = process.env[chain.safe.rpcEnv];
  const signerKey = process.env.SAFE_SIGNER_KEY;
  const oneInchApiKey = process.env.ONEINCH_API_KEY;

  if (!safeAddress) throw new Error(`${chain.safe.addressEnv} not set`);
  if (!rpcUrl) throw new Error(`${chain.safe.rpcEnv} not set`);
  if (!signerKey) throw new Error('SAFE_SIGNER_KEY not set');
  if (!oneInchApiKey) throw new Error('ONEINCH_API_KEY not set');

  // PR 2.8: RPC hostname allowlist. A tampered RPC env var would let
  // an attacker snoop signed-tx broadcast (front-run), drop txs
  // (censor), or return manipulated state reads (defeat PR 2.4 cash
  // reconciliation). Modes via RPC_VALIDATION_MODE:
  //   unset/strict → mismatch throws (default, fail-closed)
  //   warn         → log [suspicious-rpc] but continue (rollout)
  //   skip         → no check at all (genuine outage / new provider)
  const mode = process.env.RPC_VALIDATION_MODE || 'strict';
  if (mode !== 'skip' && !isAllowedRpcUrl(chainName, rpcUrl)) {
    let host = '';
    try {
      host = new URL(rpcUrl).hostname;
    } catch {
      host = '<unparseable>';
    }
    if (mode === 'warn') {
      log(
        'warn',
        'execute-trade-evm',
        `[suspicious-rpc] ${chainName}: hostname ${host} not in allowlist (RPC_VALIDATION_MODE=warn)`,
      );
    } else {
      log(
        'critical',
        'execute-trade-evm',
        `[suspicious-rpc] ${chainName}: hostname ${host} not in allowlist — refusing to execute`,
      );
      throw new Error(`rpc_hostname_not_allowlisted: ${host} on ${chainName}`);
    }
  }

  const cashToken = getCashToken(chainName);
  return {
    safeAddress,
    rpcUrl,
    signerKey,
    oneInchApiKey,
    chainId: chain.chainId,
    usdcAddress: cashToken.address,
    usdcDecimals: cashToken.decimals,
  };
}

// ============================================================
// 1inch Swap API
// ============================================================

export function build1inchUrl(chainId, params) {
  const url = new URL(`${ONEINCH_BASE_URL}/${chainId}/swap`);
  url.searchParams.set('src', params.src);
  url.searchParams.set('dst', params.dst);
  url.searchParams.set('amount', params.amount);
  url.searchParams.set('from', params.from);
  url.searchParams.set('slippage', params.slippage);
  url.searchParams.set('disableEstimate', 'true');
  if (params.receiver) url.searchParams.set('receiver', params.receiver);
  return url.toString();
}

async function get1inchSwap(chainId, params, apiKey, ctx) {
  const url = build1inchUrl(chainId, params);
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const start = Date.now();
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    if (res.ok) {
      stepLog(ctx, `1inch attempt=${attempt + 1}/${MAX_RETRIES + 1} ok (${Date.now() - start}ms)`);
      return res.json();
    }

    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Exponential backoff: 2s, 4s, 8s, 16s
      const delay = 2000 * Math.pow(2, attempt);
      stepLog(ctx, `1inch attempt=${attempt + 1}/${MAX_RETRIES + 1} status=429 backoff=${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.description) detail = parsed.description;
      else if (parsed.error) detail = parsed.error;
    } catch {
      /* use raw text */
    }
    stepLog(ctx, `1inch attempt=${attempt + 1}/${MAX_RETRIES + 1} status=${res.status} giving_up: ${detail}`);
    log('error', 'execute-trade-evm', `1inch API error (${res.status}): ${detail}`);
    throw new Error(`1inch API error (${res.status}): ${detail}`);
  }
}

// ============================================================
// ERC-20 Helpers
// ============================================================

async function getTokenDecimals(client, tokenAddress) {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'decimals',
  });
}

async function getTokenBalance(client, tokenAddress, owner) {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });
}

async function getAllowance(client, tokenAddress, owner, spender) {
  return client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [owner, spender],
  });
}

export function buildApproveCalldata(spender, amount) {
  return encodeFunctionData({
    abi: ERC20_ABI,
    functionName: 'approve',
    args: [spender, amount],
  });
}

// PR 2.5: scoped approvals. Replaces the legacy maxUint256 approval
// with `quote_amount * (1 + margin)`. Defangs the worst-case 1inch
// router compromise — instead of letting a malicious router drain
// the full Safe USDC + token balances, it can only take the in-
// flight trade amount plus the margin (default 5%).
//
// Trade-off: ~$3 extra gas per EVM buy because each swap now needs
// a fresh approval (the previous trade's allowance is consumed by
// the router or left as a tiny residual).
//
// IMPORTANT: existing Safes that previously executed under the
// legacy code path still have a maxUint256 allowance. To realize
// the full benefit, an operator should manually revoke those old
// approvals via the Safe UI. PR 2.5 only hardens NEW approvals.
//
// Tunable via env var APPROVAL_MARGIN_PCT (integer, default 5).
// Use 10 for high-volatility assets where price moves fast between
// quote and execution. Use 0 to approve the exact amount (riskier
// — any rounding will revert the swap).
//
// Exported for offline unit testing of the BigInt math.
export function computeApprovalAmount(amountWei, marginPct) {
  if (typeof amountWei !== 'bigint') {
    throw new TypeError(`computeApprovalAmount: amountWei must be bigint, got ${typeof amountWei}`);
  }
  if (amountWei < 0n) {
    throw new RangeError('computeApprovalAmount: amountWei must be non-negative');
  }
  const pct = Number.isFinite(marginPct) && marginPct >= 0 ? Math.floor(marginPct) : 5;
  // (amount * (100 + pct)) / 100 — integer math, BigInt-safe.
  return (amountWei * BigInt(100 + pct)) / 100n;
}

function getApprovalMarginPct() {
  const v = parseInt(process.env.APPROVAL_MARGIN_PCT ?? '', 10);
  return Number.isFinite(v) && v >= 0 ? v : 5;
}

// ============================================================
// Slippage Pre-Check
// ============================================================

export function checkSlippage(quoteReturn, expectedAmount, maxSlippagePct) {
  const expected = parseFloat(expectedAmount);
  const quoted = parseFloat(quoteReturn);
  if (expected === 0) return { ok: true, slippagePct: 0 };
  const slippagePct = ((expected - quoted) / expected) * 100;
  return {
    ok: slippagePct <= maxSlippagePct,
    slippagePct: parseFloat(slippagePct.toFixed(4)),
  };
}

// ============================================================
// Safe Transaction Building
// ============================================================

async function buildAndSubmitSafeTx(env, transactions, { dryRun = false, ctx } = {}) {
  stepLog(
    ctx,
    `safe_init: chainId=${env.chainId} safe=${shortAddr(env.safeAddress)} bundle_size=${transactions.length}`,
  );
  const SafeInit = Safe.init || Safe.default?.init || Safe;
  const protocolKit = await withStep('safe_init', ctx, () =>
    SafeInit({
      provider: env.rpcUrl,
      signer: env.signerKey,
      safeAddress: env.safeAddress,
    }),
  );

  const apiKit = new SafeApiKit({ chainId: BigInt(env.chainId) });

  // Use getNextNonce for correct nonce including pending txs
  const nonce = await withStep('getNextNonce', ctx, () => apiKit.getNextNonce(env.safeAddress), SAFE_RETRY);
  stepLog(ctx, `nonce=${nonce}`);

  const safeTransaction = await withStep('createTransaction', ctx, () =>
    protocolKit.createTransaction({ transactions, options: { nonce } }),
  );
  stepLog(ctx, `tx_created: nonce=${nonce} bundle_size=${transactions.length}`);

  const signedTx = await withStep('signTransaction', ctx, () => protocolKit.signTransaction(safeTransaction));
  const safeTxHash = await withStep('getTransactionHash', ctx, () => protocolKit.getTransactionHash(signedTx));

  // Derive signer address from private key (not Safe address)
  const signerAccount = privateKeyToAccount(env.signerKey.startsWith('0x') ? env.signerKey : `0x${env.signerKey}`);
  stepLog(ctx, `tx_signed: signer=${shortAddr(signerAccount.address)} safeTxHash=${safeTxHash}`);

  // Dry run: return signed tx data without proposing or executing
  if (dryRun) {
    stepLog(ctx, `dry_run: returning without propose`);
    return {
      status: 'dry_run',
      safeHash: safeTxHash,
      signerAddress: signerAccount.address,
      nonce,
      transactionCount: transactions.length,
    };
  }

  // Preflight log: capture payload shape so a 422 "Unprocessable Content"
  // response from Safe Transaction Service can be diagnosed against the
  // request we sent. signedTx.data is the SafeTransactionData we propose;
  // mismatch of `nonce`, `value`, or `data` length vs the on-chain Safe
  // is the usual cause of 422.
  const txd = signedTx.data || {};
  stepLog(
    ctx,
    `propose_payload: nonce=${txd.nonce} to=${shortAddr(txd.to)} value=${txd.value ?? '0'} data_len=${txd.data?.length ?? 0} ` +
      `op=${txd.operation ?? '?'} gasToken=${txd.gasToken ?? 'native'} signatures=${signedTx.signatures?.size ?? 0} ` +
      `safeTxHash=${safeTxHash}`,
  );
  const proposeStart = Date.now();
  await withStep(
    'proposeTransaction',
    ctx,
    () =>
      apiKit.proposeTransaction({
        safeAddress: env.safeAddress,
        safeTransactionData: signedTx.data,
        safeTxHash,
        senderAddress: signerAccount.address,
        senderSignature: signedTx.signatures.values().next().value.data,
      }),
    SAFE_RETRY,
  );
  stepLog(ctx, `proposed ok (${Date.now() - proposeStart}ms)`);

  // Check if threshold is met (threshold == 1 means we can execute immediately)
  const safeInfo = await withStep('getSafeInfo', ctx, () => apiKit.getSafeInfo(env.safeAddress), SAFE_RETRY);
  stepLog(ctx, `safe_info: threshold=${safeInfo.threshold} owners=${safeInfo.owners?.length ?? '?'}`);

  if (safeInfo.threshold === 1) {
    stepLog(ctx, `executing on-chain (threshold=1)`);
    const execStart = Date.now();
    try {
      const executionResult = await protocolKit.executeTransaction(signedTx);
      stepLog(ctx, `execution submitted, waiting for receipt`);
      const receipt = await executionResult.transactionResponse?.wait();
      const txHash = receipt?.hash || executionResult.hash;
      stepLog(ctx, `executed: txHash=${txHash} block=${receipt?.blockNumber ?? '?'} (${Date.now() - execStart}ms)`);
      return {
        status: 'executed',
        safeHash: safeTxHash,
        txHash,
      };
    } catch (execErr) {
      // Execution failed but tx is proposed
      stepLog(ctx, `ERROR executeTransaction: ${execErr.message} (${Date.now() - execStart}ms) — keeping as queued`);
      log('warn', 'execute-trade-evm', `Safe execution failed, queued: ${execErr.message} [safeHash=${safeTxHash}]`);
      return {
        status: 'queued_in_safe',
        safeHash: safeTxHash,
        note: `Proposed but execution failed: ${execErr.message}`,
      };
    }
  }

  stepLog(ctx, `queued_in_safe: threshold=${safeInfo.threshold} confirmations=1`);
  return {
    status: 'queued_in_safe',
    safeHash: safeTxHash,
    threshold: safeInfo.threshold,
    confirmations: 1,
  };
}

// ============================================================
// BUY Flow: USDC → Token
// ============================================================

async function executeBuy(args, env, { dryRun = false } = {}) {
  const ctx = { action: 'buy', chain: args.chain, symbol: args.symbol };
  stepLog(
    ctx,
    `started amount=${args.amount} tier=${args.tier} slippage=${args.maxSlippage}% address=${shortAddr(args.address)} dry_run=${dryRun}`,
  );
  const client = createPublicClient({ transport: http(env.rpcUrl) });

  // Check Safe's USDC balance
  const usdcDecimals = env.usdcDecimals;
  const usdcBalance = await withStep('rpc balanceOf(USDC)', ctx, () =>
    getTokenBalance(client, env.usdcAddress, env.safeAddress),
  );
  const usdcBalanceFormatted = parseFloat(formatUnits(usdcBalance, usdcDecimals));
  const buyAmount = parseFloat(args.amount);
  stepLog(ctx, `usdc_balance: have ${usdcBalanceFormatted}, need ${buyAmount}`);

  if (usdcBalanceFormatted < buyAmount) {
    log(
      'error',
      'execute-trade-evm',
      `BUY insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmount} [chain=${args.chain} symbol=${args.symbol}]`,
    );
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmount}`,
    };
  }

  // Get token decimals
  const tokenDecimals = await withStep('rpc decimals(token)', ctx, () => getTokenDecimals(client, args.address));
  stepLog(ctx, `token_decimals=${tokenDecimals}`);

  // Convert buy amount to USDC wei
  const amountWei = parseUnits(args.amount, usdcDecimals).toString();
  stepLog(ctx, `quote_request: 1inch src=USDC dst=${shortAddr(args.address)} amount_wei=${amountWei}`);

  // Get 1inch swap quote
  const swap = await get1inchSwap(
    env.chainId,
    {
      src: env.usdcAddress,
      dst: args.address,
      amount: amountWei,
      from: env.safeAddress,
      slippage: args.maxSlippage,
    },
    env.oneInchApiKey,
    ctx,
  );

  // Validate swap response before building Safe tx
  if (!swap?.tx?.to || !swap?.tx?.data) {
    log(
      'error',
      'execute-trade-evm',
      `BUY 1inch response missing tx fields [chain=${args.chain} symbol=${args.symbol}] keys=${JSON.stringify(Object.keys(swap?.tx || {}))}`,
    );
    return {
      status: 'failed',
      error: `1inch swap response missing required tx fields (keys: ${JSON.stringify(Object.keys(swap?.tx || {}))})`,
      action: 'buy',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // PR 2.3: hard-allowlist the swap target. If 1inch's API or DNS is
  // ever compromised, the response could redirect tx.to at an
  // attacker contract. PR 2.5 scopes the USDC approval to the trade
  // amount + margin, but defense-in-depth: refuse the swap entirely
  // if it's not going to a known-good router.
  if (!isAllowedRouter(args.chain, swap.tx.to)) {
    log(
      'critical',
      'execute-trade-evm',
      `BUY tx.to NOT in router allowlist [chain=${args.chain} symbol=${args.symbol} got=${swap.tx.to}] — refusing to sign`,
    );
    return {
      status: 'failed',
      error: `aggregator_router_not_allowlisted: ${swap.tx.to} on ${args.chain}`,
      action: 'buy',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  stepLog(
    ctx,
    `quote_ok: dstAmount=${swap.dstAmount} expected=${formatUnits(BigInt(swap.dstAmount), tokenDecimals)} ${args.symbol} router=${shortAddr(swap.tx.to)}`,
  );

  // PR 2.7: cross-check 1inch's quote against an independent price
  // source. Catches aggregator-side manipulation (compromised API,
  // sandwich within tolerance, stale-routed quote). Skipped via
  // SKIP_PRICE_ORACLE=true during a genuine source outage.
  if (process.env.SKIP_PRICE_ORACLE !== 'true') {
    const tokensOut = parseFloat(formatUnits(BigInt(swap.dstAmount), tokenDecimals));
    const quotePrice = tokensOut > 0 ? buyAmount / tokensOut : 0;
    const oracle = await fetchOraclePrice(args.chain, args.address);
    if (oracle === null) {
      stepLog(ctx, `oracle_skipped: no source agreement for ${shortAddr(args.address)} on ${args.chain}`);
    } else {
      const drift = evaluatePriceDrift({ quotePrice, oraclePrice: oracle.price });
      if (!drift.valid) {
        log(
          'critical',
          'execute-trade-evm',
          `BUY oracle_drift_exceeded src=${oracle.source} ${drift.reason} [chain=${args.chain} symbol=${args.symbol}]`,
        );
        return {
          status: 'failed',
          error: `oracle_drift_exceeded (${oracle.source}): ${drift.reason}`,
          action: 'buy',
          symbol: args.symbol,
          chain: args.chain,
        };
      }
      stepLog(
        ctx,
        `oracle_ok src=${oracle.source} quote=$${quotePrice} oracle=$${oracle.price} drift=${drift.driftPct.toFixed(2)}%`,
      );
    }
  }

  // Build Safe transactions: approve + swap
  const transactions = [];

  // Check if approval is needed
  const currentAllowance = await withStep('rpc allowance(USDC→1inch)', ctx, () =>
    getAllowance(client, env.usdcAddress, env.safeAddress, ONEINCH_ROUTER),
  );
  const approveNeeded = currentAllowance < BigInt(amountWei);
  stepLog(ctx, `allowance: current=${currentAllowance} needed=${amountWei} approve_needed=${approveNeeded}`);
  if (approveNeeded) {
    // PR 2.5: scoped — approve only this trade's amount + margin,
    // not maxUint256. Limits blast radius if 1inch is compromised.
    const approvalAmount = computeApprovalAmount(BigInt(amountWei), getApprovalMarginPct());
    transactions.push({
      to: env.usdcAddress,
      value: '0',
      data: buildApproveCalldata(ONEINCH_ROUTER, approvalAmount),
    });
    stepLog(ctx, `approval_scoped: amount=${approvalAmount} margin_pct=${getApprovalMarginPct()}`);
  }

  // Add swap transaction
  transactions.push({
    to: swap.tx.to,
    value: swap.tx.value || '0',
    data: swap.tx.data,
  });
  stepLog(ctx, `tx_built: ${transactions.length} transaction(s) (approve=${approveNeeded}, swap=true)`);

  // PR 2.6: snapshot pre-swap balance of the target token so we can
  // compute actual_received post-confirmation. Skipped for dryRun
  // since no real state change happens. Failures here downgrade to a
  // warning — we don't want to abort a valid swap because the
  // balanceOf RPC blipped.
  let preSwapBalance = null;
  if (!dryRun) {
    try {
      preSwapBalance = await client.readContract({
        address: args.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [env.safeAddress],
      });
      stepLog(ctx, `presnap: token_balance=${preSwapBalance}`);
    } catch (err) {
      stepLog(ctx, `presnap_failed: ${err.message.slice(0, 80)} — post-swap drift check disabled`);
    }
  }

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun, ctx });
  stepLog(ctx, `buy done status=${result.status} safeHash=${result.safeHash || ''} txHash=${result.txHash || ''}`);

  // PR 2.6: post-swap balance read (only on actual on-chain execution).
  let actualReceived = null;
  if (!dryRun && result.status === 'executed' && preSwapBalance !== null) {
    try {
      const postSwapBalance = await client.readContract({
        address: args.address,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [env.safeAddress],
      });
      const deltaWei = postSwapBalance - preSwapBalance;
      actualReceived = parseFloat(formatUnits(deltaWei < 0n ? 0n : deltaWei, tokenDecimals));
      stepLog(ctx, `postsnap: token_balance=${postSwapBalance} delta=${deltaWei} actual_received=${actualReceived}`);
    } catch (err) {
      stepLog(ctx, `postsnap_failed: ${err.message.slice(0, 80)}`);
    }
  }

  return {
    ...result,
    action: 'buy',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    usdcSpent: buyAmount,
    expectedTokens: formatUnits(BigInt(swap.dstAmount), tokenDecimals),
    quotedReceived: parseFloat(formatUnits(BigInt(swap.dstAmount), tokenDecimals)),
    actualReceived,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// SELL Flow: Token → USDC
// ============================================================

async function executeSell(args, env, { dryRun = false } = {}) {
  const ctx = { action: 'sell', chain: args.chain, symbol: args.symbol };
  stepLog(
    ctx,
    `started amount=${args.amount} slippage=${args.maxSlippage}% address=${shortAddr(args.address)} dry_run=${dryRun}`,
  );
  const client = createPublicClient({ transport: http(env.rpcUrl) });

  // Get token balance and decimals
  const [tokenBalance, tokenDecimals] = await Promise.all([
    withStep('rpc balanceOf(token)', ctx, () => getTokenBalance(client, args.address, env.safeAddress)),
    withStep('rpc decimals(token)', ctx, () => getTokenDecimals(client, args.address)),
  ]);
  stepLog(
    ctx,
    `token_balance: have ${formatUnits(tokenBalance, tokenDecimals)} ${args.symbol} decimals=${tokenDecimals}`,
  );

  let sellAmountWei;
  if (args.amount === 'all') {
    sellAmountWei = tokenBalance;
  } else {
    sellAmountWei = parseUnits(args.amount, tokenDecimals);
  }
  stepLog(ctx, `sell_amount_wei=${sellAmountWei} (${formatUnits(sellAmountWei, tokenDecimals)} ${args.symbol})`);

  if (sellAmountWei === 0n || tokenBalance < sellAmountWei) {
    log(
      'error',
      'execute-trade-evm',
      `SELL insufficient token balance: have ${formatUnits(tokenBalance, tokenDecimals)}, need ${args.amount} [chain=${args.chain} symbol=${args.symbol}]`,
    );
    return {
      status: 'failed',
      error: `Insufficient token balance: have ${formatUnits(tokenBalance, tokenDecimals)}, need ${args.amount}`,
    };
  }

  stepLog(ctx, `quote_request: 1inch src=${shortAddr(args.address)} dst=USDC amount_wei=${sellAmountWei}`);

  // Get 1inch swap quote
  const swap = await get1inchSwap(
    env.chainId,
    {
      src: args.address,
      dst: env.usdcAddress,
      amount: sellAmountWei.toString(),
      from: env.safeAddress,
      slippage: args.maxSlippage,
    },
    env.oneInchApiKey,
    ctx,
  );

  // Validate swap response before building Safe tx
  if (!swap?.tx?.to || !swap?.tx?.data) {
    log(
      'error',
      'execute-trade-evm',
      `SELL 1inch response missing tx fields [chain=${args.chain} symbol=${args.symbol}] keys=${JSON.stringify(Object.keys(swap?.tx || {}))}`,
    );
    return {
      status: 'failed',
      error: `1inch swap response missing required tx fields (keys: ${JSON.stringify(Object.keys(swap?.tx || {}))})`,
      action: 'sell',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // PR 2.3: same router allowlist check as the buy flow.
  if (!isAllowedRouter(args.chain, swap.tx.to)) {
    log(
      'critical',
      'execute-trade-evm',
      `SELL tx.to NOT in router allowlist [chain=${args.chain} symbol=${args.symbol} got=${swap.tx.to}] — refusing to sign`,
    );
    return {
      status: 'failed',
      error: `aggregator_router_not_allowlisted: ${swap.tx.to} on ${args.chain}`,
      action: 'sell',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  stepLog(
    ctx,
    `quote_ok: dstAmount=${swap.dstAmount} expected=${formatUnits(BigInt(swap.dstAmount), env.usdcDecimals)} USDC router=${shortAddr(swap.tx.to)}`,
  );

  // PR 2.7: oracle cross-check on the SELL side. Effective sell
  // price = USDC out / token in. Same drift threshold as buys.
  if (process.env.SKIP_PRICE_ORACLE !== 'true') {
    const usdcOut = parseFloat(formatUnits(BigInt(swap.dstAmount), env.usdcDecimals));
    const tokensIn = parseFloat(formatUnits(sellAmountWei, tokenDecimals));
    const quotePrice = tokensIn > 0 ? usdcOut / tokensIn : 0;
    const oracle = await fetchOraclePrice(args.chain, args.address);
    if (oracle === null) {
      stepLog(ctx, `oracle_skipped: no source agreement for ${shortAddr(args.address)} on ${args.chain}`);
    } else {
      const drift = evaluatePriceDrift({ quotePrice, oraclePrice: oracle.price });
      if (!drift.valid) {
        log(
          'critical',
          'execute-trade-evm',
          `SELL oracle_drift_exceeded src=${oracle.source} ${drift.reason} [chain=${args.chain} symbol=${args.symbol}]`,
        );
        return {
          status: 'failed',
          error: `oracle_drift_exceeded (${oracle.source}): ${drift.reason}`,
          action: 'sell',
          symbol: args.symbol,
          chain: args.chain,
        };
      }
      stepLog(
        ctx,
        `oracle_ok src=${oracle.source} quote=$${quotePrice} oracle=$${oracle.price} drift=${drift.driftPct.toFixed(2)}%`,
      );
    }
  }

  // Build Safe transactions: approve (if needed) + swap
  const transactions = [];

  const currentAllowance = await withStep('rpc allowance(token→1inch)', ctx, () =>
    getAllowance(client, args.address, env.safeAddress, ONEINCH_ROUTER),
  );
  const approveNeeded = currentAllowance < sellAmountWei;
  stepLog(ctx, `allowance: current=${currentAllowance} needed=${sellAmountWei} approve_needed=${approveNeeded}`);
  if (approveNeeded) {
    // PR 2.5: scoped — same as buy flow.
    const approvalAmount = computeApprovalAmount(sellAmountWei, getApprovalMarginPct());
    transactions.push({
      to: args.address,
      value: '0',
      data: buildApproveCalldata(ONEINCH_ROUTER, approvalAmount),
    });
    stepLog(ctx, `approval_scoped: amount=${approvalAmount} margin_pct=${getApprovalMarginPct()}`);
  }

  transactions.push({
    to: swap.tx.to,
    value: swap.tx.value || '0',
    data: swap.tx.data,
  });
  stepLog(ctx, `tx_built: ${transactions.length} transaction(s) (approve=${approveNeeded}, swap=true)`);

  // PR 2.6: snapshot pre-swap USDC balance (sells receive USDC).
  let preSwapUsdc = null;
  if (!dryRun) {
    try {
      preSwapUsdc = await client.readContract({
        address: env.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [env.safeAddress],
      });
      stepLog(ctx, `presnap: usdc_balance=${preSwapUsdc}`);
    } catch (err) {
      stepLog(ctx, `presnap_failed: ${err.message.slice(0, 80)} — post-swap drift check disabled`);
    }
  }

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun, ctx });
  stepLog(ctx, `sell done status=${result.status} safeHash=${result.safeHash || ''} txHash=${result.txHash || ''}`);

  const usdcDecimals = env.usdcDecimals;

  // PR 2.6: post-swap USDC balance.
  let actualReceived = null;
  if (!dryRun && result.status === 'executed' && preSwapUsdc !== null) {
    try {
      const postSwapUsdc = await client.readContract({
        address: env.usdcAddress,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [env.safeAddress],
      });
      const deltaWei = postSwapUsdc - preSwapUsdc;
      actualReceived = parseFloat(formatUnits(deltaWei < 0n ? 0n : deltaWei, usdcDecimals));
      stepLog(ctx, `postsnap: usdc_balance=${postSwapUsdc} delta=${deltaWei} actual_received=${actualReceived}`);
    } catch (err) {
      stepLog(ctx, `postsnap_failed: ${err.message.slice(0, 80)}`);
    }
  }

  return {
    ...result,
    action: 'sell',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    tokensSold: formatUnits(sellAmountWei, tokenDecimals),
    expectedUsdc: formatUnits(BigInt(swap.dstAmount), usdcDecimals),
    quotedReceived: parseFloat(formatUnits(BigInt(swap.dstAmount), usdcDecimals)),
    actualReceived,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// Main
// ============================================================

async function main() {
  const args = parseArgs();
  const errors = validateArgs(args);

  if (errors.length > 0) {
    console.error(`Error: ${errors.join(', ')}`);
    process.exit(1);
  }

  let env;
  try {
    env = resolveConfig(args.chain);
  } catch (err) {
    // Sanitize error — never leak key values
    const msg = err.message.replace(process.env.SAFE_SIGNER_KEY || '__none__', '[REDACTED]');
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  try {
    const opts = { dryRun: args.dryRun };
    const result = args.action === 'buy' ? await executeBuy(args, env, opts) : await executeSell(args, env, opts);

    // Safety: ensure no private key in output
    const output = JSON.stringify(result, null, 2);
    if (process.env.SAFE_SIGNER_KEY && output.includes(process.env.SAFE_SIGNER_KEY)) {
      log(
        'critical',
        'execute-trade-evm',
        `FATAL: Private key detected in output [action=${args.action} chain=${args.chain} symbol=${args.symbol}]`,
      );
      console.error('FATAL: Private key detected in output — aborting');
      process.exit(1);
    }

    console.log(output);
    process.exit(result.status === 'failed' ? 1 : 0);
  } catch (err) {
    const errorMsg = err.message || String(err);
    // Sanitize any potential key leakage
    const safeMsg = process.env.SAFE_SIGNER_KEY
      ? errorMsg.replace(process.env.SAFE_SIGNER_KEY, '[REDACTED]')
      : errorMsg;

    log(
      'critical',
      'execute-trade-evm',
      `crash: ${safeMsg} [action=${args.action} chain=${args.chain} symbol=${args.symbol}]`,
    );
    console.log(
      JSON.stringify(
        {
          status: 'failed',
          error: safeMsg,
          action: args.action,
          symbol: args.symbol,
          chain: args.chain,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    process.exit(1);
  }
}

// Only run main when executed directly (not when imported for testing)
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMainModule) {
  main();
}
