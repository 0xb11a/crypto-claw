#!/usr/bin/env node
/**
 * check-wallets.js — Track smart money wallet activity
 *
 * Usage:
 *   node scripts/check-wallets.js
 *   node scripts/check-wallets.js --add 0x1234... --label "Smart Whale 1"
 *   node scripts/check-wallets.js --positions   (check wallets related to open positions)
 */

import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { resolve } from 'path';

const WALLETS_FILE = resolve(process.cwd(), 'workspace/memory/tracked-wallets.json');

function loadWallets() {
  if (!existsSync(WALLETS_FILE)) return [];
  try {
    return JSON.parse(readFileSync(WALLETS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

function saveWallets(wallets) {
  writeFileSync(WALLETS_FILE, JSON.stringify(wallets, null, 2));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { action: 'check', address: '', label: '', positions: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--add': config.action = 'add'; config.address = args[++i]; break;
      case '--label': config.label = args[++i]; break;
      case '--remove': config.action = 'remove'; config.address = args[++i]; break;
      case '--positions': config.positions = true; break;
      case '--list': config.action = 'list'; break;
    }
  }
  return config;
}

async function checkWalletActivity(address, chain = 'ethereum') {
  // In production, this would use Etherscan/Solscan APIs to check recent transactions
  // For now, return a structured placeholder
  const etherscanKey = process.env.ETHERSCAN_API_KEY;
  if (!etherscanKey) {
    return {
      address,
      status: 'no_api_key',
      message: 'Set ETHERSCAN_API_KEY to enable wallet tracking',
    };
  }

  try {
    const url = `https://api.etherscan.io/api?module=account&action=tokentx&address=${address}&page=1&offset=10&sort=desc&apikey=${etherscanKey}`;
    const res = await fetch(url);
    const data = await res.json();

    if (data.status !== '1') {
      return { address, status: 'no_activity', recentTransactions: [] };
    }

    const txs = (data.result ?? []).map(tx => ({
      hash: tx.hash,
      tokenSymbol: tx.tokenSymbol,
      tokenAddress: tx.contractAddress,
      from: tx.from,
      to: tx.to,
      value: tx.value,
      timestamp: new Date(parseInt(tx.timeStamp) * 1000).toISOString(),
      direction: tx.from.toLowerCase() === address.toLowerCase() ? 'sell' : 'buy',
    }));

    return {
      address,
      status: 'ok',
      recentTransactions: txs,
      lastActivity: txs[0]?.timestamp ?? null,
    };
  } catch (err) {
    return { address, status: 'error', error: err.message };
  }
}

async function main() {
  const config = parseArgs();
  let wallets = loadWallets();

  switch (config.action) {
    case 'add': {
      if (!config.address) {
        console.error('Error: --add requires an address');
        process.exit(1);
      }
      wallets.push({
        address: config.address,
        label: config.label || `Wallet ${wallets.length + 1}`,
        addedAt: new Date().toISOString(),
        chain: 'ethereum', // default
      });
      saveWallets(wallets);
      console.log(JSON.stringify({
        status: 'ok',
        action: 'added',
        wallet: { address: config.address, label: config.label },
        totalTracked: wallets.length,
      }, null, 2));
      return;
    }

    case 'remove': {
      wallets = wallets.filter(w => w.address.toLowerCase() !== config.address.toLowerCase());
      saveWallets(wallets);
      console.log(JSON.stringify({
        status: 'ok',
        action: 'removed',
        address: config.address,
        totalTracked: wallets.length,
      }, null, 2));
      return;
    }

    case 'list': {
      console.log(JSON.stringify({
        status: 'ok',
        wallets,
        totalTracked: wallets.length,
      }, null, 2));
      return;
    }

    case 'check':
    default: {
      if (wallets.length === 0) {
        console.log(JSON.stringify({
          status: 'ok',
          message: 'No wallets being tracked. Use --add to add wallets.',
          wallets: [],
        }, null, 2));
        return;
      }

      const results = [];
      for (const wallet of wallets) {
        const activity = await checkWalletActivity(wallet.address, wallet.chain);
        results.push({
          label: wallet.label,
          ...activity,
        });
        await new Promise(r => setTimeout(r, 250)); // rate limit
      }

      // Find noteworthy activity
      const noteworthy = results.filter(r =>
        r.recentTransactions?.some(tx => {
          const age = Date.now() - new Date(tx.timestamp).getTime();
          return age < 3_600_000; // activity in last hour
        })
      );

      console.log(JSON.stringify({
        status: 'ok',
        tracked: wallets.length,
        recentActivity: noteworthy.length,
        wallets: results,
        timestamp: new Date().toISOString(),
      }, null, 2));
    }
  }
}

main();
