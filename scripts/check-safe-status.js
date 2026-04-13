#!/usr/bin/env node
/**
 * check-safe-status.js — Query Safe wallet status and pending transactions
 *
 * Usage:
 *   node scripts/check-safe-status.js --chain base
 *   node scripts/check-safe-status.js --chain base --safe-hash 0x...
 */

import 'dotenv/config';
import { log } from './log.js';
import { getChain, getCashToken } from './chains.js';
import { createPublicClient, http, formatUnits, parseAbi } from 'viem';
import SafeApiKitModule from '@safe-global/api-kit';
const SafeApiKit = SafeApiKitModule.default || SafeApiKitModule;

const SAFE_TX_SERVICE_URLS = {
  1: 'https://safe-transaction-mainnet.safe.global',
  8453: 'https://safe-transaction-base.safe.global',
  42161: 'https://safe-transaction-arbitrum.safe.global',
  10: 'https://safe-transaction-optimism.safe.global',
};

// USDC address resolved per-chain from chains.js

const ERC20_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: '', safeHash: '' };
  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--chain':
        config.chain = args[i + 1];
        break;
      case '--safe-hash':
        config.safeHash = args[i + 1];
        break;
    }
  }
  if (!config.chain) {
    log('error', 'check-safe-status', '--chain is required');
    console.error('Error: --chain is required');
    process.exit(1);
  }
  return config;
}

function resolveConfig(chainName) {
  const chain = getChain(chainName);
  const safeAddress = process.env[chain.safe.addressEnv];
  const rpcUrl = process.env[chain.safe.rpcEnv];

  if (!safeAddress) {
    log('error', 'check-safe-status', `${chain.safe.addressEnv} not set`);
    console.error(`Error: ${chain.safe.addressEnv} not set`);
    process.exit(1);
  }
  if (!rpcUrl) {
    log('error', 'check-safe-status', `${chain.safe.rpcEnv} not set`);
    console.error(`Error: ${chain.safe.rpcEnv} not set`);
    process.exit(1);
  }

  const txServiceUrl = SAFE_TX_SERVICE_URLS[chain.chainId];
  if (!txServiceUrl) {
    log(
      'error',
      'check-safe-status',
      `No Safe Transaction Service URL for chain ${chainName} (chainId: ${chain.chainId})`,
    );
    console.error(`Error: No Safe Transaction Service URL for chain ${chainName} (chainId: ${chain.chainId})`);
    process.exit(1);
  }

  return { safeAddress, rpcUrl, chainId: chain.chainId, txServiceUrl, chainName };
}

async function retryOnRateLimit(fn, retries = 2, delay = 2000) {
  for (let i = 0; i <= retries; i++) {
    try {
      return await fn();
    } catch (err) {
      const is429 = err.message?.includes('Too Many Requests') || err.status === 429;
      if (is429 && i < retries) {
        await new Promise((r) => setTimeout(r, delay * (i + 1)));
        continue;
      }
      throw err;
    }
  }
}

async function getSafeInfo(config) {
  const apiKit = new SafeApiKit({ chainId: BigInt(config.chainId) });
  const client = createPublicClient({ transport: http(config.rpcUrl) });

  // On-chain reads (RPC) in parallel, Safe API calls sequentially to avoid rate limits
  const [ethBalance, usdcBalance] = await Promise.all([
    client.getBalance({ address: config.safeAddress }),
    getUsdcBalance(client, config),
  ]);

  const safeInfo = await retryOnRateLimit(() => apiKit.getSafeInfo(config.safeAddress));
  const pendingTxs = await retryOnRateLimit(() => apiKit.getPendingTransactions(config.safeAddress));

  return {
    status: 'ok',
    safe: {
      address: config.safeAddress,
      chain: config.chainId,
      nonce: safeInfo.nonce,
      threshold: safeInfo.threshold,
      owners: safeInfo.owners,
    },
    balances: {
      eth: formatUnits(ethBalance, 18),
      usdc: usdcBalance,
    },
    pendingTransactions: {
      count: pendingTxs.count,
      results: pendingTxs.results.map((tx) => ({
        safeHash: tx.safeTxHash,
        nonce: tx.nonce,
        confirmations: tx.confirmations?.length ?? 0,
        confirmationsRequired: tx.confirmationsRequired,
        submitted: tx.submissionDate,
        to: tx.to,
        value: tx.value,
        executed: tx.isExecuted,
      })),
    },
    timestamp: new Date().toISOString(),
  };
}

async function getTransactionStatus(config) {
  const apiKit = new SafeApiKit({ chainId: BigInt(config.chainId) });

  const tx = await retryOnRateLimit(() => apiKit.getTransaction(config.safeHash));

  return {
    status: 'ok',
    transaction: {
      safeHash: tx.safeTxHash,
      nonce: tx.nonce,
      to: tx.to,
      value: tx.value,
      executed: tx.isExecuted,
      txHash: tx.transactionHash || null,
      confirmations:
        tx.confirmations?.map((c) => ({
          owner: c.owner,
          signature: c.signature?.slice(0, 20) + '...',
          submitted: c.submissionDate,
        })) ?? [],
      confirmationsRequired: tx.confirmationsRequired,
      submissionDate: tx.submissionDate,
      executionDate: tx.executionDate || null,
      isSuccessful: tx.isSuccessful,
    },
    timestamp: new Date().toISOString(),
  };
}

async function getUsdcBalance(client, config) {
  const usdcAddr = config.chainName ? getCashToken(config.chainName).address : null;
  if (!usdcAddr) return null;

  try {
    const [balance, decimals] = await Promise.all([
      client.readContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'balanceOf',
        args: [config.safeAddress],
      }),
      client.readContract({
        address: usdcAddr,
        abi: ERC20_ABI,
        functionName: 'decimals',
      }),
    ]);
    return formatUnits(balance, decimals);
  } catch {
    return null;
  }
}

async function main() {
  const args = parseArgs();
  const config = resolveConfig(args.chain);
  config.safeHash = args.safeHash;

  try {
    const result = args.safeHash ? await getTransactionStatus(config) : await getSafeInfo(config);

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    log('error', 'check-safe-status', `Failed: ${err.message}`);
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
