#!/usr/bin/env node
/**
 * check-contract.js — Safety check using GoPlus Security API
 *
 * Usage:
 *   node scripts/check-contract.js --address 0x1234... --chain ethereum
 *   node scripts/check-contract.js --address 0x1234... --chain ethereum --deep
 *   node scripts/check-contract.js --changes                              # scan all open positions
 *   node scripts/check-contract.js --changes --address 0x... --chain base # scan one token
 */

import 'dotenv/config';
import { getChain, isSolana } from './chains.js';
import { log } from './log.js';
import { requireValidAddress } from './address-validator.js';

const GOPLUS_BASE = 'https://api.gopluslabs.io/api/v1';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { address: '', chain: '', deep: false, changes: false };
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--address':
        config.address = args[++i];
        break;
      case '--chain':
        config.chain = args[++i];
        break;
      case '--deep':
        config.deep = true;
        break;
      case '--changes':
        config.changes = true;
        break;
    }
  }
  if (!config.changes && (!config.address || !config.chain)) {
    console.error('Error: --address and --chain are required (or use --changes)');
    process.exit(1);
  }
  return config;
}

async function checkEVMToken(address, chainId, chainName) {
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
    flags.push({
      type: 'ownership_risk',
      severity: 'high',
      description: 'Owner can reclaim ownership after renouncing',
    });
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
  const criticalCount = flags.filter((f) => f.severity === 'critical').length;
  const highCount = flags.filter((f) => f.severity === 'high').length;
  const mediumCount = flags.filter((f) => f.severity === 'medium').length;

  let riskScore = criticalCount * 30 + highCount * 15 + mediumCount * 5;
  riskScore = Math.min(100, riskScore);

  const autoReject = criticalCount > 0;

  return {
    status: 'ok',
    address,
    chain: chainName,
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
      topHolders: (info.holders ?? []).slice(0, 10).map((h) => ({
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

async function checkSolanaToken(address, chainCfg) {
  const url = `${GOPLUS_BASE}/${chainCfg.goplus.endpoint}/token_security?contract_addresses=${address}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GoPlus API error: ${res.status}`);
  const data = await res.json();

  if (data.code !== 1) throw new Error(`GoPlus error: ${data.message}`);

  const info = data.result?.[address];
  if (!info) return { status: 'not_found', address };

  const flags = [];

  if (info.is_honeypot === '1') {
    flags.push({ type: 'honeypot', severity: 'critical', description: 'Honeypot detected — cannot sell' });
  }
  if (info.is_mintable === '1') {
    flags.push({
      type: 'mintable',
      severity: 'high',
      description: 'Token supply can be increased (mint authority active)',
    });
  }
  if (info.freeze_authority) {
    flags.push({
      type: 'freeze_authority',
      severity: 'high',
      description: 'Freeze authority set — tokens can be frozen in wallets',
    });
  }
  if (info.close_authority) {
    flags.push({
      type: 'close_authority',
      severity: 'high',
      description: 'Close authority set — token accounts can be closed',
    });
  }
  if (info.transfer_pausable === '1') {
    flags.push({ type: 'pausable', severity: 'critical', description: 'Transfers can be paused' });
  }
  if (info.is_blacklisted === '1') {
    flags.push({ type: 'blacklist', severity: 'high', description: 'Token has blacklist functionality' });
  }
  if (info.owner_change_balance === '1') {
    flags.push({ type: 'balance_manipulation', severity: 'critical', description: 'Owner can modify token balances' });
  }
  if (info.hidden_owner === '1') {
    flags.push({ type: 'hidden_owner', severity: 'high', description: 'Hidden ownership mechanism detected' });
  }

  const buyTax = parseFloat(info.buy_tax ?? 0) * 100;
  const sellTax = parseFloat(info.sell_tax ?? 0) * 100;
  if (buyTax > 10) {
    flags.push({ type: 'high_buy_tax', severity: 'high', description: `Buy tax: ${buyTax.toFixed(1)}%` });
  }
  if (sellTax > 10) {
    flags.push({ type: 'high_sell_tax', severity: 'high', description: `Sell tax: ${sellTax.toFixed(1)}%` });
  }

  const criticalCount = flags.filter((f) => f.severity === 'critical').length;
  const highCount = flags.filter((f) => f.severity === 'high').length;
  const mediumCount = flags.filter((f) => f.severity === 'medium').length;

  let riskScore = criticalCount * 30 + highCount * 15 + mediumCount * 5;
  riskScore = Math.min(100, riskScore);

  const autoReject = criticalCount > 0;

  return {
    status: 'ok',
    address,
    chain: 'solana',
    safety: {
      isHoneypot: info.is_honeypot === '1',
      isMintable: info.is_mintable === '1',
      hasFreezeAuthority: !!info.freeze_authority,
      hasCloseAuthority: !!info.close_authority,
      canPause: info.transfer_pausable === '1',
      hasBlacklist: info.is_blacklisted === '1',
      ownerCanChangeBalance: info.owner_change_balance === '1',
      buyTax,
      sellTax,
    },
    owner: {
      address: info.owner_address ?? 'unknown',
    },
    holders: {
      count: parseInt(info.holder_count ?? 0),
      topHolders: (info.holders ?? []).slice(0, 10).map((h) => ({
        address: h.address,
        percent: (parseFloat(h.percent ?? 0) * 100).toFixed(2),
        isContract: h.is_contract === 1,
      })),
    },
    flags,
    riskScore,
    autoReject,
    verdict: autoReject ? 'REJECT' : riskScore > 50 ? 'HIGH_RISK' : riskScore > 25 ? 'MODERATE_RISK' : 'LOW_RISK',
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// --changes mode: scan positions for contract changes
// ============================================================

// Fields to diff between snapshots
const DIFF_FIELDS = [
  { key: 'is_honeypot', alertType: 'CONTRACT_HONEYPOT', severity: 'CRITICAL', label: 'Became honeypot' },
  { key: 'is_proxy', alertType: 'CONTRACT_PROXY_CHANGE', severity: 'CRITICAL', label: 'Proxy status changed' },
  { key: 'owner_address', alertType: 'CONTRACT_OWNERSHIP_TRANSFER', severity: 'HIGH', label: 'Owner changed' },
  { key: 'transfer_pausable', alertType: 'CONTRACT_PAUSABLE', severity: 'CRITICAL', label: 'Became pausable' },
  { key: 'is_blacklisted', alertType: 'CONTRACT_BLACKLIST', severity: 'CRITICAL', label: 'Blacklist added' },
  { key: 'is_mintable', alertType: 'CONTRACT_MINTABLE', severity: 'HIGH', label: 'Became mintable' },
];

function extractDiffable(safetyData) {
  return {
    is_honeypot: safetyData.is_honeypot ?? '0',
    is_proxy: safetyData.is_proxy ?? '0',
    owner_address: safetyData.owner_address ?? 'unknown',
    transfer_pausable: safetyData.transfer_pausable ?? '0',
    is_blacklisted: safetyData.is_blacklisted ?? '0',
    is_mintable: safetyData.is_mintable ?? '0',
    buy_tax: safetyData.buy_tax ?? '0',
    sell_tax: safetyData.sell_tax ?? '0',
  };
}

function diffSnapshots(prev, current, address, chain, symbol) {
  const alerts = [];
  const prevFields = extractDiffable(prev);
  const curFields = extractDiffable(current);

  for (const field of DIFF_FIELDS) {
    if (prevFields[field.key] !== curFields[field.key]) {
      alerts.push({
        address,
        symbol,
        chain,
        severity: field.severity,
        type: field.alertType,
        previousValue: prevFields[field.key],
        currentValue: curFields[field.key],
        message: `${field.label}: ${prevFields[field.key]} → ${curFields[field.key]}`,
      });
    }
  }

  // Tax increase check (>5 percentage points)
  const prevBuyTax = parseFloat(prevFields.buy_tax) * 100;
  const curBuyTax = parseFloat(curFields.buy_tax) * 100;
  const prevSellTax = parseFloat(prevFields.sell_tax) * 100;
  const curSellTax = parseFloat(curFields.sell_tax) * 100;

  if (curBuyTax - prevBuyTax > 5) {
    alerts.push({
      address,
      symbol,
      chain,
      severity: 'HIGH',
      type: 'CONTRACT_TAX_INCREASE',
      previousValue: `${prevBuyTax.toFixed(1)}%`,
      currentValue: `${curBuyTax.toFixed(1)}%`,
      message: `Buy tax increased: ${prevBuyTax.toFixed(1)}% → ${curBuyTax.toFixed(1)}%`,
    });
  }
  if (curSellTax - prevSellTax > 5) {
    alerts.push({
      address,
      symbol,
      chain,
      severity: 'HIGH',
      type: 'CONTRACT_TAX_INCREASE',
      previousValue: `${prevSellTax.toFixed(1)}%`,
      currentValue: `${curSellTax.toFixed(1)}%`,
      message: `Sell tax increased: ${prevSellTax.toFixed(1)}% → ${curSellTax.toFixed(1)}%`,
    });
  }

  return alerts;
}

async function fetchRawSafetyData(address, chain) {
  const chainCfg = getChain(chain);
  if (isSolana(chain)) {
    const url = `${GOPLUS_BASE}/${chainCfg.goplus.endpoint}/token_security?contract_addresses=${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 1) return null;
    return data.result?.[address] ?? null;
  } else {
    const url = `${GOPLUS_BASE}/token_security/${chainCfg.goplus.chainId}?contract_addresses=${address}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    if (data.code !== 1) return null;
    return data.result?.[address.toLowerCase()] ?? null;
  }
}

async function runChangesMode(config) {
  const { getDb, close } = await import('./db.js');
  const db = getDb();

  // Determine targets
  let targets;
  if (config.address && config.chain) {
    targets = [{ address: config.address, chain: config.chain, symbol: config.address.slice(0, 8) }];
  } else {
    const isPaper = process.env.PAPER_MODE === 'true';
    const table = isPaper ? 'paper_positions' : 'positions';
    targets = db
      .prepare(
        `SELECT address, chain, symbol FROM ${table} WHERE status IN ('open', 'partial_exit') ORDER BY created_at DESC`,
      )
      .all();
  }

  if (targets.length === 0) {
    console.log(
      JSON.stringify(
        {
          status: 'ok',
          message: 'No open positions to check contracts for',
          tracked: 0,
          alertCount: 0,
          alerts: [],
          positions: {},
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
    close();
    return;
  }

  const alerts = [];
  const positions = {};

  for (const target of targets) {
    try {
      const rawData = await fetchRawSafetyData(target.address, target.chain);
      if (!rawData) continue;

      // Load previous snapshot
      const prev = db
        .prepare(
          'SELECT safety_data FROM contract_snapshots WHERE address = ? AND chain = ? ORDER BY checked_at DESC LIMIT 1',
        )
        .get(target.address, target.chain);

      // Write new snapshot
      db.prepare('INSERT INTO contract_snapshots (address, chain, safety_data) VALUES (?, ?, ?)').run(
        target.address,
        target.chain,
        JSON.stringify(rawData),
      );

      // Diff if we have a previous snapshot
      if (prev) {
        const prevData = JSON.parse(prev.safety_data);
        const posAlerts = diffSnapshots(prevData, rawData, target.address, target.chain, target.symbol);
        alerts.push(...posAlerts);
      }

      positions[target.address] = {
        symbol: target.symbol,
        chain: target.chain,
        hasPreviousSnapshot: !!prev,
        alertCount: prev
          ? diffSnapshots(JSON.parse(prev.safety_data), rawData, target.address, target.chain, target.symbol).length
          : 0,
        lastChecked: new Date().toISOString(),
      };
    } catch (err) {
      log(
        'warn',
        'check-contract',
        `Changes check failed for ${target.symbol ?? target.address} (${target.chain}): ${err.message}`,
      );
      continue;
    }

    await new Promise((r) => setTimeout(r, 200));
  }

  console.log(
    JSON.stringify(
      {
        status: 'ok',
        tracked: targets.length,
        alertCount: alerts.length,
        alerts,
        positions,
        timestamp: new Date().toISOString(),
      },
      null,
      2,
    ),
  );

  close();
}

// ============================================================
// Main
// ============================================================

async function main() {
  const config = parseArgs();

  if (config.changes) {
    await runChangesMode(config);
    return;
  }

  try {
    const chainCfg = getChain(config.chain);
    // Reject invalid CA at the boundary before we hit GoPlus / spend an
    // API call OR feed a poisoned address into the agent's context.
    const validatedAddress = requireValidAddress(config.address, config.chain);

    if (isSolana(config.chain)) {
      const result = await checkSolanaToken(validatedAddress, chainCfg);
      console.log(JSON.stringify(result, null, 2));
    } else {
      const result = await checkEVMToken(validatedAddress, chainCfg.goplus.chainId, config.chain);
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (err) {
    console.log(
      JSON.stringify({
        status: err.code === 'invalid_address' ? 'invalid_address' : 'error',
        error: err.message,
        timestamp: new Date().toISOString(),
      }),
    );
    process.exit(1);
  }
}

main();
