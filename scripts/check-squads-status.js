#!/usr/bin/env node
/**
 * check-squads-status.js — Query Squads multisig status and pending transactions
 *
 * Usage:
 *   node scripts/check-squads-status.js
 *   node scripts/check-squads-status.js --pending
 */

import 'dotenv/config';
import { getChain, getCashToken } from './chains.js';
import { Connection, PublicKey, LAMPORTS_PER_SOL } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount } from '@solana/spl-token';
import * as multisig from '@sqds/multisig';

const solCashToken = getCashToken('solana');
const USDC_MINT = new PublicKey(solCashToken.address);
const USDC_DECIMALS = solCashToken.decimals;

function parseArgs() {
  const args = process.argv.slice(2);
  const config = { pending: false };
  for (const arg of args) {
    if (arg === '--pending') config.pending = true;
  }
  return config;
}

function resolveConfig() {
  const chain = getChain('solana');
  if (!chain.squads) {
    throw new Error('Solana chain config missing squads section');
  }

  const rpcUrl = process.env[chain.squads.rpcEnv];
  if (!rpcUrl) throw new Error(`${chain.squads.rpcEnv} not set`);

  const directVault = process.env[chain.squads.vaultEnv];
  const multisigAddress = process.env[chain.squads.multisigEnv];

  let multisigPda = null;
  let vaultPda;

  if (directVault) {
    // Direct vault address — no multisig PDA derivation
    vaultPda = new PublicKey(directVault);
    if (multisigAddress) multisigPda = new PublicKey(multisigAddress);
  } else if (multisigAddress) {
    // Derive vault from multisig PDA
    multisigPda = new PublicKey(multisigAddress);
    [vaultPda] = multisig.getVaultPda({
      multisigPda,
      index: chain.squads.vaultIndex,
    });
  } else {
    throw new Error(`${chain.squads.vaultEnv} or ${chain.squads.multisigEnv} must be set`);
  }

  return {
    connection: new Connection(rpcUrl, 'confirmed'),
    multisigPda,
    vaultPda,
    vaultIndex: chain.squads.vaultIndex,
  };
}

async function getUsdcBalance(connection, owner) {
  try {
    const ata = await getAssociatedTokenAddress(USDC_MINT, owner, true);
    const account = await getAccount(connection, ata);
    return Number(account.amount) / 10 ** USDC_DECIMALS;
  } catch {
    return 0;
  }
}

async function getSquadsInfo(env, showPending) {
  const { connection, multisigPda, vaultPda } = env;

  // Get balances in parallel
  const [solBalance, usdcBalance] = await Promise.all([
    connection.getBalance(vaultPda),
    getUsdcBalance(connection, vaultPda),
  ]);

  const result = {
    status: 'ok',
    vault: {
      address: vaultPda.toString(),
      balances: {
        sol: solBalance / LAMPORTS_PER_SOL,
        usdc: usdcBalance,
      },
    },
    timestamp: new Date().toISOString(),
  };

  // Multisig info only available when multisig PDA is configured
  if (multisigPda) {
    try {
      const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
        connection,
        multisigPda,
      );
      result.multisig = {
        address: multisigPda.toString(),
        threshold: Number(multisigAccount.threshold),
        members: multisigAccount.members.map(m => ({
          key: m.key.toString(),
          permissions: m.permissions,
        })),
        transactionIndex: Number(multisigAccount.transactionIndex),
      };

      // Scan for pending proposals if requested
      if (showPending) {
        const pending = [];
        const txCount = Number(multisigAccount.transactionIndex);
        const startIdx = Math.max(1, txCount - 19);
        for (let i = txCount; i >= startIdx; i--) {
          try {
            const [proposalPda] = multisig.getProposalPda({
              multisigPda,
              transactionIndex: BigInt(i),
            });
            const proposal = await multisig.accounts.Proposal.fromAccountAddress(
              connection,
              proposalPda,
            );
            if (proposal.status && proposal.status.__kind === 'Active') {
              pending.push({
                transactionIndex: i,
                approved: proposal.approved?.length ?? 0,
                rejected: proposal.rejected?.length ?? 0,
              });
            }
          } catch {
            continue;
          }
        }
        result.pendingTransactions = { count: pending.length, transactions: pending };
      }
    } catch {
      result.multisig = { status: 'unavailable', note: 'SQUADS_MULTISIG_ADDRESS not set or not a valid multisig account' };
    }
  } else {
    result.multisig = { status: 'not_configured', note: 'Only SQUADS_VAULT_ADDRESS is set — multisig info unavailable' };
  }

  return result;
}

async function main() {
  const args = parseArgs();

  let env;
  try {
    env = resolveConfig();
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  }

  try {
    const result = await getSquadsInfo(env, args.pending);
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.log(JSON.stringify({
      status: 'error',
      error: err.message,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  }
}

main();
