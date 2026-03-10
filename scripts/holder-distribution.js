#!/usr/bin/env node
/**
 * holder-distribution.js — Check token holder distribution
 *
 * Usage:
 *   node scripts/holder-distribution.js --address 0x1234... --chain ethereum
 */

import 'dotenv/config';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';
const CHAIN_IDS = {
  ethereum: '1', bsc: '56', polygon: '137',
  arbitrum: '42161', base: '8453',
  // Solana uses a different endpoint — handled separately in main()
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '' };
  for (let i = 0; i < args.length; i += 2) {
    if (args[i] === '--address') config.address = args[i + 1];
    if (args[i] === '--chain') config.chain = args[i + 1];
  }
  if (!config.address || !config.chain) {
    console.error('Error: --address and --chain are required');
    process.exit(1);
  }
  return config;
}

async function main() {
  const config = parseArgs();
  const chainId = CHAIN_IDS[config.chain];

  if (!chainId && config.chain !== 'solana') {
    console.log(JSON.stringify({
      status: 'error',
      error: `Unsupported chain: ${config.chain}`,
    }));
    process.exit(1);
  }

  try {
    const url = config.chain === 'solana'
      ? `${GOPLUS_BASE}/solana/token_security?contract_addresses=${config.address}`
      : `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${config.address}`;
    const res = await fetch(url);
    const data = await res.json();

    // Solana addresses are base58 (case-sensitive); EVM addresses are hex (case-insensitive)
    const key = config.chain === 'solana' ? config.address : config.address.toLowerCase();
    const info = data.result?.[key];
    if (!info) {
      console.log(JSON.stringify({ status: 'not_found', address: config.address }));
      return;
    }

    const holders = (info.holders ?? []).map((h, i) => ({
      rank: i + 1,
      address: h.address,
      percent: parseFloat((parseFloat(h.percent ?? 0) * 100).toFixed(2)),
      isContract: h.is_contract === 1,
      isLocked: h.is_locked === 1,
      tag: h.tag ?? null,
    }));

    const top10Percent = holders.slice(0, 10).reduce((sum, h) => sum + h.percent, 0);
    const top5Percent = holders.slice(0, 5).reduce((sum, h) => sum + h.percent, 0);

    // Risk flags
    const flags = [];
    if (holders[0]?.percent > 30 && !holders[0]?.isContract && !holders[0]?.isLocked) {
      flags.push({ severity: 'critical', message: `Top holder owns ${holders[0].percent}% (not locked)` });
    }
    if (top10Percent > 50) {
      flags.push({ severity: 'high', message: `Top 10 holders own ${top10Percent.toFixed(1)}%` });
    }

    console.log(JSON.stringify({
      status: 'ok',
      address: config.address,
      chain: config.chain,
      totalHolders: parseInt(info.holder_count ?? 0),
      concentration: {
        top1: holders[0]?.percent ?? 0,
        top5: parseFloat(top5Percent.toFixed(2)),
        top10: parseFloat(top10Percent.toFixed(2)),
      },
      topHolders: holders.slice(0, 20),
      flags,
      timestamp: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: err.message,
    }));
    process.exit(1);
  }
}

main();
