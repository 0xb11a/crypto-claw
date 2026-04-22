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
import { getChain, getCashToken } from './chains.js';
import { createPublicClient, http, parseAbi, encodeFunctionData, formatUnits, parseUnits, maxUint256 } from 'viem';
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

async function withStep(label, ctx, fn) {
  const start = Date.now();
  try {
    return await fn();
  } catch (err) {
    const status = err.status || err.response?.status || err.code || '';
    const body = err.response?.data ?? err.response?.body ?? err.data ?? '';
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const detailParts = [status ? `HTTP ${status}` : '', bodyStr ? bodyStr.slice(0, 300) : ''].filter(Boolean);
    const detail = detailParts.length ? ` [${detailParts.join(' ')}]` : '';
    const msg = `${label}: ${err.message}${detail}`;
    stepLog(ctx, `ERROR ${msg} (${Date.now() - start}ms)`);
    const wrapped = new Error(msg);
    wrapped.cause = err;
    throw wrapped;
  }
}

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
  const nonce = await withStep('getNextNonce', ctx, () => apiKit.getNextNonce(env.safeAddress));
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

  stepLog(ctx, `proposing to safe_tx_service`);
  const proposeStart = Date.now();
  try {
    await apiKit.proposeTransaction({
      safeAddress: env.safeAddress,
      safeTransactionData: signedTx.data,
      safeTxHash,
      senderAddress: signerAccount.address,
      senderSignature: signedTx.signatures.values().next().value.data,
    });
    stepLog(ctx, `proposed ok (${Date.now() - proposeStart}ms)`);
  } catch (proposeErr) {
    const status = proposeErr.status || proposeErr.response?.status || proposeErr.code || '';
    const body =
      proposeErr.response?.data ||
      proposeErr.response?.body ||
      (typeof proposeErr.data === 'object' ? JSON.stringify(proposeErr.data) : proposeErr.data) ||
      '';
    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
    const detail = [
      'Safe proposeTransaction failed',
      status ? `(HTTP ${status})` : '',
      bodyStr ? `: ${bodyStr.slice(0, 500)}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    stepLog(ctx, `ERROR proposeTransaction: ${detail || proposeErr.message} (${Date.now() - proposeStart}ms)`);
    log('error', 'execute-trade-evm', `Safe proposeTransaction failed: ${detail || proposeErr.message}`);
    throw new Error(detail || proposeErr.message);
  }

  // Check if threshold is met (threshold == 1 means we can execute immediately)
  const safeInfo = await withStep('getSafeInfo', ctx, () => apiKit.getSafeInfo(env.safeAddress));
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

  stepLog(
    ctx,
    `quote_ok: dstAmount=${swap.dstAmount} expected=${formatUnits(BigInt(swap.dstAmount), tokenDecimals)} ${args.symbol} router=${shortAddr(swap.tx.to)}`,
  );

  // Build Safe transactions: approve + swap
  const transactions = [];

  // Check if approval is needed
  const currentAllowance = await withStep('rpc allowance(USDC→1inch)', ctx, () =>
    getAllowance(client, env.usdcAddress, env.safeAddress, ONEINCH_ROUTER),
  );
  const approveNeeded = currentAllowance < BigInt(amountWei);
  stepLog(ctx, `allowance: current=${currentAllowance} needed=${amountWei} approve_needed=${approveNeeded}`);
  if (approveNeeded) {
    transactions.push({
      to: env.usdcAddress,
      value: '0',
      data: buildApproveCalldata(ONEINCH_ROUTER, maxUint256),
    });
  }

  // Add swap transaction
  transactions.push({
    to: swap.tx.to,
    value: swap.tx.value || '0',
    data: swap.tx.data,
  });
  stepLog(ctx, `tx_built: ${transactions.length} transaction(s) (approve=${approveNeeded}, swap=true)`);

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun, ctx });
  stepLog(ctx, `buy done status=${result.status} safeHash=${result.safeHash || ''} txHash=${result.txHash || ''}`);

  return {
    ...result,
    action: 'buy',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    usdcSpent: buyAmount,
    expectedTokens: formatUnits(BigInt(swap.dstAmount), tokenDecimals),
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

  stepLog(
    ctx,
    `quote_ok: dstAmount=${swap.dstAmount} expected=${formatUnits(BigInt(swap.dstAmount), env.usdcDecimals)} USDC router=${shortAddr(swap.tx.to)}`,
  );

  // Build Safe transactions: approve (if needed) + swap
  const transactions = [];

  const currentAllowance = await withStep('rpc allowance(token→1inch)', ctx, () =>
    getAllowance(client, args.address, env.safeAddress, ONEINCH_ROUTER),
  );
  const approveNeeded = currentAllowance < sellAmountWei;
  stepLog(ctx, `allowance: current=${currentAllowance} needed=${sellAmountWei} approve_needed=${approveNeeded}`);
  if (approveNeeded) {
    transactions.push({
      to: args.address,
      value: '0',
      data: buildApproveCalldata(ONEINCH_ROUTER, maxUint256),
    });
  }

  transactions.push({
    to: swap.tx.to,
    value: swap.tx.value || '0',
    data: swap.tx.data,
  });
  stepLog(ctx, `tx_built: ${transactions.length} transaction(s) (approve=${approveNeeded}, swap=true)`);

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun, ctx });
  stepLog(ctx, `sell done status=${result.status} safeHash=${result.safeHash || ''} txHash=${result.txHash || ''}`);

  const usdcDecimals = env.usdcDecimals;
  return {
    ...result,
    action: 'sell',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    tokensSold: formatUnits(sellAmountWei, tokenDecimals),
    expectedUsdc: formatUnits(BigInt(swap.dstAmount), usdcDecimals),
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
