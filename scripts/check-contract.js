#!/usr/bin/env node
/**
 * check-contract.js — Safety check using GoPlus Security API
 *
 * Usage:
 *   node scripts/check-contract.js --address 0x1234... --chain ethereum
 *   node scripts/check-contract.js --address 0x1234... --chain ethereum --deep
 */

import 'dotenv/config';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';

// GoPlus chain IDs
const CHAIN_IDS = {
  ethereum: '1',
  bsc: '56',
  polygon: '137',
  arbitrum: '42161',
  base: '8453',
  // Solana uses a different endpoint
};

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '', deep: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--address': config.address = args[++i]; break;
      case '--chain': config.chain = args[++i]; break;
      case '--deep': config.deep = true; break;
      case '--changes': config.changes = true; break;
    }
  }
  if (!config.address || !config.chain) {
    console.error('Error: --address and --chain are required');
    process.exit(1);
  }
  return config;
}

async function checkEVMToken(address, chainId) {
  const url = `${GOPLUS_BASE}/token_security/${chainId}?contract_addresses=${address}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GoPlus API error: ${res.status}`);
  const data = await res.json();

  if (data.code !== 1) throw new Error(`GoPlus error: ${data.message}`);

  const info = data.result?.[address.toLowerCase()];
  if (!info) return { status: 'not_found', address };

  // Parse safety signals
  const flags = [];

  if (info.is_honeypot === '1') {
    flags.push({ type: 'honeypot', severity: 'critical', description: 'Honeypot detected — cannot sell' });
  }
  if (info.is_open_source !== '1') {
    flags.push({ type: 'unverified', severity: 'high', description: 'Contract source code not verified' });
  }
  if (info.is_proxy === '1') {
    flags.push({ type: 'proxy', severity: 'high', description: 'Proxy/upgradeable contract' });
  }
  if (info.can_take_back_ownership === '1') {
    flags.push({ type: 'ownership_risk', severity: 'high', description: 'Owner can reclaim ownership after renouncing' });
  }
  if (info.owner_change_balance === '1') {
    flags.push({ type: 'balance_manipulation', severity: 'critical', description: 'Owner can modify token balances' });
  }
  if (info.hidden_owner === '1') {
    flags.push({ type: 'hidden_owner', severity: 'high', description: 'Hidden ownership mechanism detected' });
  }
  if (info.selfdestruct === '1') {
    flags.push({ type: 'selfdestruct', severity: 'critical', description: 'Contract can self-destruct' });
  }
  if (info.external_call === '1') {
    flags.push({ type: 'external_call', severity: 'medium', description: 'Contract makes external calls' });
  }
  if (info.is_mintable === '1') {
    flags.push({ type: 'mintable', severity: 'high', description: 'Token supply can be increased' });
  }
  if (info.transfer_pausable === '1') {
    flags.push({ type: 'pausable', severity: 'critical', description: 'Transfers can be paused by owner' });
  }
  if (info.is_blacklisted === '1') {
    flags.push({ type: 'blacklist', severity: 'high', description: 'Token has blacklist functionality' });
  }
  if (info.trading_cooldown === '1') {
    flags.push({ type: 'cooldown', severity: 'medium', description: 'Trading cooldown mechanism present' });
  }
  if (info.is_anti_whale === '1') {
    flags.push({ type: 'anti_whale', severity: 'low', description: 'Anti-whale mechanism (max transaction limit)' });
  }

  const buyTax = parseFloat(info.buy_tax ?? 0) * 100;
  const sellTax = parseFloat(info.sell_tax ?? 0) * 100;
  if (buyTax > 10) {
    flags.push({ type: 'high_buy_tax', severity: 'high', description: `Buy tax: ${buyTax.toFixed(1)}%` });
  }
  if (sellTax > 10) {
    flags.push({ type: 'high_sell_tax', severity: 'high', description: `Sell tax: ${sellTax.toFixed(1)}%` });
  }

  // Calculate overall risk score
  const criticalCount = flags.filter(f => f.severity === 'critical').length;
  const highCount = flags.filter(f => f.severity === 'high').length;
  const mediumCount = flags.filter(f => f.severity === 'medium').length;

  let riskScore = criticalCount * 30 + highCount * 15 + mediumCount * 5;
  riskScore = Math.min(100, riskScore);

  const autoReject = criticalCount > 0;

  return {
    status: 'ok',
    address,
    chain: Object.entries(CHAIN_IDS).find(([, v]) => v === chainId)?.[0],
    safety: {
      isHoneypot: info.is_honeypot === '1',
      isOpenSource: info.is_open_source === '1',
      isProxy: info.is_proxy === '1',
      isMintable: info.is_mintable === '1',
      canPause: info.transfer_pausable === '1',
      hasBlacklist: info.is_blacklisted === '1',
      ownerCanChangeBalance: info.owner_change_balance === '1',
      buyTax: buyTax,
      sellTax: sellTax,
    },
    owner: {
      address: info.owner_address ?? 'unknown',
      isRenounced: info.owner_address === '0x0000000000000000000000000000000000000000',
    },
    holders: {
      count: parseInt(info.holder_count ?? 0),
      topHolders: (info.holders ?? []).slice(0, 10).map(h => ({
        address: h.address,
        percent: (parseFloat(h.percent ?? 0) * 100).toFixed(2),
        isContract: h.is_contract === 1,
        isLocked: h.is_locked === 1,
      })),
    },
    flags,
    riskScore,
    autoReject,
    verdict: autoReject ? 'REJECT' : riskScore > 50 ? 'HIGH_RISK' : riskScore > 25 ? 'MODERATE_RISK' : 'LOW_RISK',
    timestamp: new Date().toISOString(),
  };
}

async function main() {
  const config = parseArgs();

  try {
    const chainId = CHAIN_IDS[config.chain];

    if (!chainId && config.chain !== 'solana') {
      throw new Error(`Unsupported chain: ${config.chain}. Supported: ${Object.keys(CHAIN_IDS).join(', ')}, solana`);
    }

    if (config.chain === 'solana') {
      // Solana uses a different GoPlus endpoint
      const url = `${GOPLUS_BASE}/solana/token_security?contract_addresses=${config.address}`;
      const res = await fetch(url);
      const data = await res.json();
      console.log(JSON.stringify({ status: 'ok', chain: 'solana', raw: data, timestamp: new Date().toISOString() }, null, 2));
    } else {
      const result = await checkEVMToken(config.address, chainId);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
    process.exit(1);
  }
}

main();
