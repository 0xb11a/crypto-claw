#!/usr/bin/env node
/**
 * check-signer-balances.js — Check signer account native token balances
 *
 * Monitors the accounts that pay transaction fees (gas/SOL) for Safe and
 * Squads multisig operations. Alerts when balances drop below per-chain
 * thresholds configured in chains.js.
 *
 * Usage:
 *   node scripts/check-signer-balances.js
 *   node scripts/check-signer-balances.js --chain base
 *
 * Output: JSON with per-chain balances and threshold comparison
 */

import 'dotenv/config';
import { getActiveChains, getChain, getSignerThreshold } from './chains.js';
import { createPublicClient, http, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js';
import bs58 from 'bs58';
import { log } from './log.js';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { chain: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--chain' && args[i + 1]) config.chain = args[++i];
  }
  return config;
}

function redactAddress(addr) {
  if (!addr || addr.length < 10) return '***';
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

async function getEvmSignerBalance(chain, signerAddress) {
  const rpcUrl = process.env[chain.safe.rpcEnv];
  if (!rpcUrl) return { chain: chain.name, status: 'skipped', reason: `${chain.safe.rpcEnv} not set` };

  const client = createPublicClient({ transport: http(rpcUrl) });
  const balanceWei = await client.getBalance({ address: signerAddress });
  const balance = parseFloat(formatUnits(balanceWei, chain.nativeToken.decimals));
  const threshold = getSignerThreshold(chain.name);

  return {
    chain: chain.name,
    address: redactAddress(signerAddress),
    symbol: chain.nativeToken.symbol,
    balance: balance.toFixed(6),
    threshold: String(threshold),
    belowThreshold: balance < threshold,
  };
}

async function getSolanaSignerBalance(chain) {
  const signerKeyBase58 = process.env[chain.squads.signerKeyEnv];
  if (!signerKeyBase58) return { chain: chain.name, status: 'skipped', reason: `${chain.squads.signerKeyEnv} not set` };

  const rpcUrl = process.env[chain.squads.rpcEnv];
  if (!rpcUrl) return { chain: chain.name, status: 'skipped', reason: `${chain.squads.rpcEnv} not set` };

  const signer = Keypair.fromSecretKey(bs58.decode(signerKeyBase58));
  const pubkey = signer.publicKey;
  const connection = new Connection(rpcUrl);
  const lamports = await connection.getBalance(pubkey);
  const balance = lamports / LAMPORTS_PER_SOL;
  const threshold = getSignerThreshold(chain.name);

  return {
    chain: chain.name,
    address: redactAddress(pubkey.toBase58()),
    symbol: chain.nativeToken.symbol,
    balance: balance.toFixed(6),
    threshold: String(threshold),
    belowThreshold: balance < threshold,
  };
}

async function main() {
  const { chain: filterChain } = parseArgs();

  const activeNames = filterChain ? [filterChain] : getActiveChains();
  const promises = [];

  // Derive EVM signer address once (same key for all EVM chains)
  let evmSignerAddress = null;
  const evmSignerKey = process.env.SAFE_SIGNER_KEY;
  if (evmSignerKey) {
    try {
      const account = privateKeyToAccount(evmSignerKey.startsWith('0x') ? evmSignerKey : `0x${evmSignerKey}`);
      evmSignerAddress = account.address;
    } catch (err) {
      log('error', 'check-signer-balances', `Failed to derive EVM signer address: ${err.message}`);
    }
  }

  for (const name of activeNames) {
    let chain;
    try {
      chain = getChain(name);
    } catch {
      continue;
    }

    if (chain.type === 'evm' && chain.safe) {
      if (!evmSignerAddress) {
        promises.push(Promise.resolve({ chain: name, status: 'skipped', reason: 'SAFE_SIGNER_KEY not set' }));
      } else {
        promises.push(
          getEvmSignerBalance(chain, evmSignerAddress).catch((err) => ({
            chain: name,
            status: 'error',
            reason: err.message,
          })),
        );
      }
    } else if (chain.type === 'solana' && chain.squads) {
      promises.push(
        getSolanaSignerBalance(chain).catch((err) => ({
          chain: name,
          status: 'error',
          reason: err.message,
        })),
      );
    }
  }

  const results = await Promise.allSettled(promises);
  const signerBalances = results.map((r) =>
    r.status === 'fulfilled' ? r.value : { status: 'error', reason: r.reason?.message || 'Unknown error' },
  );

  const anyBelowThreshold = signerBalances.some((b) => b.belowThreshold === true);

  const output = {
    status: 'ok',
    signerBalances,
    anyBelowThreshold,
    timestamp: new Date().toISOString(),
  };

  console.log(JSON.stringify(output, null, 2));
}

main().catch((err) => {
  log('error', 'check-signer-balances', err.message);
  console.log(JSON.stringify({ status: 'error', error: err.message }));
  process.exit(1);
});
