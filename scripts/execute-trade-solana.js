#!/usr/bin/env node
/**
 * execute-trade-solana.js — Build, sign, and submit Jupiter swaps through Squads multisig
 *
 * Usage:
 *   node scripts/execute-trade-solana.js \
 *     --action buy|sell --chain solana --address <mint> --symbol TOKEN \
 *     --amount 500 --max-slippage 5 --tier moonshot
 *
 * BUY: USDC → Token (amount is USD value)
 * SELL: Token → USDC (amount is "all" or token quantity)
 *
 * Output: JSON with status "executed", "queued_in_squads", or "failed"
 */

import 'dotenv/config';
import { getChain, getCashToken } from './chains.js';
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';

// ============================================================
// Constants
// ============================================================

const solCashToken = getCashToken('solana');
const USDC_MINT = new PublicKey(solCashToken.address);
const USDC_DECIMALS = solCashToken.decimals;
const JUPITER_API = getChain('solana').jupiter.apiUrl;

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
  };
  for (let i = 0; i < args.length; i += 2) {
    switch (args[i]) {
      case '--action': config.action = args[i + 1]; break;
      case '--chain': config.chain = args[i + 1]; break;
      case '--address': config.address = args[i + 1]; break;
      case '--symbol': config.symbol = args[i + 1]; break;
      case '--amount': config.amount = args[i + 1]; break;
      case '--max-slippage': config.maxSlippage = args[i + 1]; break;
      case '--tier': config.tier = args[i + 1]; break;
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
// Config Resolution
// ============================================================

function resolveConfig(chainName) {
  const chain = getChain(chainName);
  if (!chain.squads) throw new Error(`Chain ${chainName} does not have Squads config`);

  const multisigAddress = process.env[chain.squads.multisigEnv];
  const signerKeyBase58 = process.env[chain.squads.signerKeyEnv];
  const rpcUrl = process.env[chain.squads.rpcEnv];

  // Multisig PDA is always required — Squads needs it to create vault transactions
  if (!multisigAddress) throw new Error(`${chain.squads.multisigEnv} not set`);
  if (!signerKeyBase58) throw new Error(`${chain.squads.signerKeyEnv} not set`);
  if (!rpcUrl) throw new Error(`${chain.squads.rpcEnv} not set`);

  const multisigPda = new PublicKey(multisigAddress);
  const signer = Keypair.fromSecretKey(bs58.decode(signerKeyBase58));

  // Direct vault address takes priority — no derivation needed
  const directVault = process.env[chain.squads.vaultEnv];
  let vaultPda;
  if (directVault) {
    vaultPda = new PublicKey(directVault);
  } else {
    // Fall back to deriving vault from multisig PDA
    [vaultPda] = multisig.getVaultPda({
      multisigPda,
      index: chain.squads.vaultIndex,
    });
  }

  return {
    connection: new Connection(rpcUrl, 'confirmed'),
    multisigPda,
    vaultPda,
    signer,
    vaultIndex: chain.squads.vaultIndex,
  };
}

// ============================================================
// SPL Token Helpers
// ============================================================

async function getTokenBalance(connection, mint, owner) {
  try {
    const ata = await getAssociatedTokenAddress(mint, owner, true);
    const account = await getAccount(connection, ata);
    return account.amount;
  } catch {
    return 0n;
  }
}

// ============================================================
// Jupiter API
// ============================================================

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps) {
  const params = new URLSearchParams({
    inputMint: inputMint.toString(),
    outputMint: outputMint.toString(),
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
  });

  const res = await fetch(`${JUPITER_API}/quote?${params}`);
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter quote error (${res.status}): ${text}`);
  }
  return res.json();
}

async function getJupiterSwapInstructions(quoteResponse, userPublicKey) {
  const res = await fetch(`${JUPITER_API}/swap-instructions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      quoteResponse,
      userPublicKey: userPublicKey.toString(),
      wrapAndUnwrapSol: true,
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Jupiter swap-instructions error (${res.status}): ${text}`);
  }
  return res.json();
}

function deserializeInstruction(ix) {
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map(a => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

// ============================================================
// Squads Transaction Building
// ============================================================

async function buildAndSubmitSquadsTx(env, instructions) {
  const { connection, multisigPda, vaultPda, signer, vaultIndex } = env;

  // Get current multisig state for transaction index
  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda,
  );
  const transactionIndex = Number(multisigAccount.transactionIndex) + 1;
  const transactionIndexBN = BigInt(transactionIndex);

  // Build transaction message from Jupiter instructions
  const blockhash = await connection.getLatestBlockhash();
  const txMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash.blockhash,
    instructions,
  });

  // Count ephemeral signers needed (instructions referencing the vault as signer
  // that aren't the vault itself)
  const ephemeralSigners = 0;

  // 1. Create vault transaction
  const createTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
    vaultIndex,
    ephemeralSigners,
    transactionMessage: txMessage,
  });

  // 2. Create proposal
  const createProposalIx = multisig.instructions.proposalCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
  });

  // 3. Approve proposal
  const approveIx = multisig.instructions.proposalApprove({
    multisigPda,
    transactionIndex: transactionIndexBN,
    member: signer.publicKey,
  });

  // Build and send the meta-transaction (create + propose + approve)
  const metaMessage = new TransactionMessage({
    payerKey: signer.publicKey,
    recentBlockhash: blockhash.blockhash,
    instructions: [createTxIx, createProposalIx, approveIx],
  }).compileToV0Message();

  const metaTx = new VersionedTransaction(metaMessage);
  metaTx.sign([signer]);

  const metaSig = await connection.sendTransaction(metaTx, {
    skipPreflight: false,
  });
  await connection.confirmTransaction({
    signature: metaSig,
    blockhash: blockhash.blockhash,
    lastValidBlockHeight: blockhash.lastValidBlockHeight,
  });

  // 4. Check threshold — if met, execute
  const threshold = Number(multisigAccount.threshold);
  if (threshold <= 1) {
    try {
      const executeTxIx = multisig.instructions.vaultTransactionExecute({
        multisigPda,
        transactionIndex: transactionIndexBN,
        member: signer.publicKey,
      });

      const execBlockhash = await connection.getLatestBlockhash();
      const execMessage = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: execBlockhash.blockhash,
        instructions: [executeTxIx],
      }).compileToV0Message();

      const execTx = new VersionedTransaction(execMessage);
      execTx.sign([signer]);

      const execSig = await connection.sendTransaction(execTx, {
        skipPreflight: false,
      });
      await connection.confirmTransaction({
        signature: execSig,
        blockhash: execBlockhash.blockhash,
        lastValidBlockHeight: execBlockhash.lastValidBlockHeight,
      });

      return {
        status: 'executed',
        txSignature: execSig,
        squadsTransactionIndex: transactionIndex,
      };
    } catch (execErr) {
      return {
        status: 'queued_in_squads',
        txSignature: metaSig,
        squadsTransactionIndex: transactionIndex,
        note: `Proposed and approved but execution failed: ${execErr.message}`,
      };
    }
  }

  return {
    status: 'queued_in_squads',
    txSignature: metaSig,
    squadsTransactionIndex: transactionIndex,
    threshold,
    confirmations: 1,
  };
}

// ============================================================
// BUY Flow: USDC → Token
// ============================================================

async function executeBuy(args, env) {
  const tokenMint = new PublicKey(args.address);
  const buyAmountUsd = parseFloat(args.amount);

  // Check vault's USDC balance
  const usdcBalance = await getTokenBalance(env.connection, USDC_MINT, env.vaultPda);
  const usdcBalanceFormatted = Number(usdcBalance) / 10 ** USDC_DECIMALS;

  if (usdcBalanceFormatted < buyAmountUsd) {
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`,
    };
  }

  // Convert USD to USDC lamports
  const usdcLamports = BigInt(Math.round(buyAmountUsd * 10 ** USDC_DECIMALS));

  // Slippage in basis points
  const slippageBps = Math.round(parseFloat(args.maxSlippage) * 100);

  // Get Jupiter quote
  const quote = await getJupiterQuote(USDC_MINT, tokenMint, usdcLamports, slippageBps);

  // Get swap instructions for the vault
  const swapData = await getJupiterSwapInstructions(quote, env.vaultPda);

  // Combine all instructions
  const allInstructions = [];
  if (swapData.setupInstructions) {
    allInstructions.push(...swapData.setupInstructions.map(deserializeInstruction));
  }
  allInstructions.push(deserializeInstruction(swapData.swapInstruction));
  if (swapData.cleanupInstruction) {
    allInstructions.push(deserializeInstruction(swapData.cleanupInstruction));
  }

  const result = await buildAndSubmitSquadsTx(env, allInstructions);

  return {
    ...result,
    action: 'buy',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    usdcSpent: buyAmountUsd,
    expectedTokens: quote.outAmount,
    timestamp: new Date().toISOString(),
  };
}

// ============================================================
// SELL Flow: Token → USDC
// ============================================================

async function executeSell(args, env) {
  const tokenMint = new PublicKey(args.address);

  // Get vault's token balance
  const tokenBalance = await getTokenBalance(env.connection, tokenMint, env.vaultPda);

  if (tokenBalance === 0n) {
    return {
      status: 'failed',
      error: `No token balance found for ${args.symbol} in vault`,
    };
  }

  let sellAmount;
  if (args.amount === 'all') {
    sellAmount = tokenBalance;
  } else {
    sellAmount = BigInt(args.amount);
    if (tokenBalance < sellAmount) {
      return {
        status: 'failed',
        error: `Insufficient token balance: have ${tokenBalance.toString()}, need ${args.amount}`,
      };
    }
  }

  // Slippage in basis points
  const slippageBps = Math.round(parseFloat(args.maxSlippage) * 100);

  // Get Jupiter quote (token → USDC)
  const quote = await getJupiterQuote(tokenMint, USDC_MINT, sellAmount, slippageBps);

  // Get swap instructions for the vault
  const swapData = await getJupiterSwapInstructions(quote, env.vaultPda);

  // Combine all instructions
  const allInstructions = [];
  if (swapData.setupInstructions) {
    allInstructions.push(...swapData.setupInstructions.map(deserializeInstruction));
  }
  allInstructions.push(deserializeInstruction(swapData.swapInstruction));
  if (swapData.cleanupInstruction) {
    allInstructions.push(deserializeInstruction(swapData.cleanupInstruction));
  }

  const result = await buildAndSubmitSquadsTx(env, allInstructions);

  const expectedUsdc = Number(quote.outAmount) / 10 ** USDC_DECIMALS;

  return {
    ...result,
    action: 'sell',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    tokensSold: sellAmount.toString(),
    expectedUsdc: expectedUsdc.toFixed(2),
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
    const signerKey = process.env.SQUADS_SIGNER_KEY || '__none__';
    const msg = err.message.replace(signerKey, '[REDACTED]');
    console.error(`Error: ${msg}`);
    process.exit(1);
  }

  try {
    const result = args.action === 'buy'
      ? await executeBuy(args, env)
      : await executeSell(args, env);

    // Safety: ensure no private key in output
    const output = JSON.stringify(result, null, 2);
    if (process.env.SQUADS_SIGNER_KEY && output.includes(process.env.SQUADS_SIGNER_KEY)) {
      console.error('FATAL: Private key detected in output — aborting');
      process.exit(1);
    }

    console.log(output);
    process.exit(result.status === 'failed' ? 1 : 0);
  } catch (err) {
    const errorMsg = err.message || String(err);
    const safeMsg = process.env.SQUADS_SIGNER_KEY
      ? errorMsg.replace(process.env.SQUADS_SIGNER_KEY, '[REDACTED]')
      : errorMsg;

    console.log(JSON.stringify({
      status: 'failed',
      error: safeMsg,
      action: args.action,
      symbol: args.symbol,
      chain: args.chain,
      timestamp: new Date().toISOString(),
    }, null, 2));
    process.exit(1);
  }
}

// Only run main when executed directly
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMainModule) {
  main();
}
