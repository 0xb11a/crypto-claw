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

async function get1inchSwap(chainId, params, apiKey) {
  const url = build1inchUrl(chainId, params);
  const MAX_RETRIES = 4;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    });

    if (res.ok) return res.json();

    if (res.status === 429 && attempt < MAX_RETRIES) {
      // Exponential backoff: 2s, 4s, 8s, 16s
      const delay = 2000 * Math.pow(2, attempt);
      await new Promise((r) => setTimeout(r, delay));
      continue;
    }

    const text = await res.text();
    throw new Error(`1inch API error (${res.status}): ${text}`);
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

async function buildAndSubmitSafeTx(env, transactions, { dryRun = false } = {}) {
  const SafeInit = Safe.init || Safe.default?.init || Safe;
  const protocolKit = await SafeInit({
    provider: env.rpcUrl,
    signer: env.signerKey,
    safeAddress: env.safeAddress,
  });

  const apiKit = new SafeApiKit({ chainId: BigInt(env.chainId) });

  // Use getNextNonce for correct nonce including pending txs
  const nonce = await apiKit.getNextNonce(env.safeAddress);

  const safeTransaction = await protocolKit.createTransaction({
    transactions,
    options: { nonce },
  });

  const signedTx = await protocolKit.signTransaction(safeTransaction);
  const safeTxHash = await protocolKit.getTransactionHash(signedTx);

  // Derive signer address from private key (not Safe address)
  const signerAccount = privateKeyToAccount(env.signerKey.startsWith('0x') ? env.signerKey : `0x${env.signerKey}`);

  // Dry run: return signed tx data without proposing or executing
  if (dryRun) {
    return {
      status: 'dry_run',
      safeHash: safeTxHash,
      signerAddress: signerAccount.address,
      nonce,
      transactionCount: transactions.length,
    };
  }

  await apiKit.proposeTransaction({
    safeAddress: env.safeAddress,
    safeTransactionData: signedTx.data,
    safeTxHash,
    senderAddress: signerAccount.address,
    senderSignature: signedTx.signatures.values().next().value.data,
  });

  // Check if threshold is met (threshold == 1 means we can execute immediately)
  const safeInfo = await apiKit.getSafeInfo(env.safeAddress);
  if (safeInfo.threshold === 1) {
    try {
      const executionResult = await protocolKit.executeTransaction(signedTx);
      const receipt = await executionResult.transactionResponse?.wait();
      return {
        status: 'executed',
        safeHash: safeTxHash,
        txHash: receipt?.hash || executionResult.hash,
      };
    } catch (execErr) {
      // Execution failed but tx is proposed
      return {
        status: 'queued_in_safe',
        safeHash: safeTxHash,
        note: `Proposed but execution failed: ${execErr.message}`,
      };
    }
  }

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
  const client = createPublicClient({ transport: http(env.rpcUrl) });

  // Check Safe's USDC balance
  const usdcDecimals = env.usdcDecimals;
  const usdcBalance = await getTokenBalance(client, env.usdcAddress, env.safeAddress);
  const usdcBalanceFormatted = parseFloat(formatUnits(usdcBalance, usdcDecimals));
  const buyAmount = parseFloat(args.amount);

  if (usdcBalanceFormatted < buyAmount) {
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmount}`,
    };
  }

  // Get token decimals
  const tokenDecimals = await getTokenDecimals(client, args.address);

  // Convert buy amount to USDC wei
  const amountWei = parseUnits(args.amount, usdcDecimals).toString();

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
  );

  // Build Safe transactions: approve + swap
  const transactions = [];

  // Check if approval is needed
  const currentAllowance = await getAllowance(client, env.usdcAddress, env.safeAddress, ONEINCH_ROUTER);
  if (currentAllowance < BigInt(amountWei)) {
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

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun });

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
  const client = createPublicClient({ transport: http(env.rpcUrl) });

  // Get token balance and decimals
  const [tokenBalance, tokenDecimals] = await Promise.all([
    getTokenBalance(client, args.address, env.safeAddress),
    getTokenDecimals(client, args.address),
  ]);

  let sellAmountWei;
  if (args.amount === 'all') {
    sellAmountWei = tokenBalance;
  } else {
    sellAmountWei = parseUnits(args.amount, tokenDecimals);
  }

  if (sellAmountWei === 0n || tokenBalance < sellAmountWei) {
    return {
      status: 'failed',
      error: `Insufficient token balance: have ${formatUnits(tokenBalance, tokenDecimals)}, need ${args.amount}`,
    };
  }

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
  );

  // Build Safe transactions: approve (if needed) + swap
  const transactions = [];

  const currentAllowance = await getAllowance(client, args.address, env.safeAddress, ONEINCH_ROUTER);
  if (currentAllowance < sellAmountWei) {
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

  const result = await buildAndSubmitSafeTx(env, transactions, { dryRun });

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
