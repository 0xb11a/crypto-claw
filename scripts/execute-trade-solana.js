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
import { getChain, getCashToken, isAllowedSwapProgram, isAllowedAncillaryProgram, isAllowedRpcUrl } from './chains.js';
import { fetchOraclePrice, evaluatePriceDrift } from './price-oracle.js';
import {
  Connection,
  PublicKey,
  Keypair,
  TransactionMessage,
  VersionedTransaction,
  TransactionInstruction,
  AddressLookupTableAccount,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  getAccount,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import * as multisig from '@sqds/multisig';
import bs58 from 'bs58';
import { log } from './log.js';

// ============================================================
// Logging helpers
// ============================================================

const shortAddr = (a) => {
  if (!a) return '';
  const s = typeof a === 'string' ? a : a.toString?.() || '';
  return s.length > 10 ? `${s.slice(0, 6)}...${s.slice(-4)}` : s;
};

function stepLog(ctx, msg) {
  const tag = ctx ? `[${ctx.action} ${ctx.chain}/${ctx.symbol}] ` : '';
  log('info', 'execute-trade-solana', `${tag}${msg}`);
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

  // PR 2.8: RPC hostname allowlist (same as EVM). Defangs threat
  // #14 — a tampered RPC env could front-run / censor / fake state.
  const mode = process.env.RPC_VALIDATION_MODE || 'strict';
  if (mode !== 'skip' && !isAllowedRpcUrl(chainName, rpcUrl)) {
    let host = '';
    try {
      host = new URL(rpcUrl).hostname;
    } catch {
      host = '<unparseable>';
    }
    if (mode === 'warn') {
      log(
        'warn',
        'execute-trade-solana',
        `[suspicious-rpc] ${chainName}: hostname ${host} not in allowlist (RPC_VALIDATION_MODE=warn)`,
      );
    } else {
      log(
        'critical',
        'execute-trade-solana',
        `[suspicious-rpc] ${chainName}: hostname ${host} not in allowlist — refusing to execute`,
      );
      throw new Error(`rpc_hostname_not_allowlisted: ${host} on ${chainName}`);
    }
  }

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

async function detectTokenProgram(connection, mint, ctx) {
  const accountInfo = await withStep('rpc getAccountInfo(mint)', ctx, () => connection.getAccountInfo(mint));
  if (!accountInfo) throw new Error(`Mint account not found: ${mint.toString()}`);
  if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  return TOKEN_PROGRAM_ID;
}

async function getTokenBalance(connection, mint, owner, ctx) {
  try {
    const programId = await detectTokenProgram(connection, mint, ctx);
    const ata = await getAssociatedTokenAddress(mint, owner, true, programId);
    const account = await withStep('rpc getAccount(ata)', ctx, () => getAccount(connection, ata, undefined, programId));
    return account.amount;
  } catch (err) {
    // ATA missing or closed is a legitimate "no balance" case; anything else is surfaced
    const msg = String(err?.message || err);
    if (msg.includes('TokenAccountNotFoundError') || msg.includes('could not find account')) {
      stepLog(ctx, `token_balance=0 (ata not found for mint=${shortAddr(mint)})`);
      return 0n;
    }
    stepLog(ctx, `WARN getTokenBalance swallowed: ${msg} — treating as 0`);
    return 0n;
  }
}

// ============================================================
// Jupiter API
// ============================================================

async function getJupiterQuote(inputMint, outputMint, amount, slippageBps, ctx) {
  const params = new URLSearchParams({
    inputMint: inputMint.toString(),
    outputMint: outputMint.toString(),
    amount: amount.toString(),
    slippageBps: slippageBps.toString(),
    // Accounts referenced by Jupiter LUTs take 1 byte inside the Squads meta-tx
    // instead of 32, so we can use Jupiter's default account budget. Keep a
    // modest cap as headroom against Squads' own meta-tx account overhead.
    maxAccounts: '30',
  });

  const start = Date.now();
  const res = await fetch(`${JUPITER_API}/quote?${params}`);
  if (!res.ok) {
    const text = await res.text();
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) detail = parsed.error;
      else if (parsed.message) detail = parsed.message;
    } catch {
      /* use raw text */
    }
    stepLog(ctx, `jupiter quote status=${res.status} (${Date.now() - start}ms) detail=${detail}`);
    const errMsg = `Jupiter quote error (${res.status}): ${detail}`;
    log('error', 'execute-trade-solana', errMsg);
    throw new Error(errMsg);
  }
  stepLog(ctx, `jupiter quote ok (${Date.now() - start}ms)`);
  return res.json();
}

async function getJupiterSwapInstructions(quoteResponse, userPublicKey, ctx) {
  const start = Date.now();
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
    let detail = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed.error) detail = parsed.error;
      else if (parsed.message) detail = parsed.message;
    } catch {
      /* use raw text */
    }
    stepLog(ctx, `jupiter swap-instructions status=${res.status} (${Date.now() - start}ms) detail=${detail}`);
    const errMsg = `Jupiter swap-instructions error (${res.status}): ${detail}`;
    log('error', 'execute-trade-solana', errMsg);
    throw new Error(errMsg);
  }
  stepLog(ctx, `jupiter swap-instructions ok (${Date.now() - start}ms)`);
  return res.json();
}

function deserializeInstruction(ix) {
  if (!ix?.programId || !ix?.data || !Array.isArray(ix?.accounts)) {
    const keys = Object.keys(ix || {});
    throw new Error(`Invalid instruction: missing required fields (keys: ${JSON.stringify(keys)})`);
  }
  return new TransactionInstruction({
    programId: new PublicKey(ix.programId),
    keys: ix.accounts.map((a) => ({
      pubkey: new PublicKey(a.pubkey),
      isSigner: a.isSigner,
      isWritable: a.isWritable,
    })),
    data: Buffer.from(ix.data, 'base64'),
  });
}

// PR 2.3: validate every instruction's programId before we let Squads
// sign over it. The threat model: Jupiter's API gets compromised /
// MITM'd, the response includes a malicious setupInstruction whose
// programId is an attacker contract. That instruction would execute
// from the vault's signing context BEFORE the legit swap, and could
// drain the vault. Hard-allowlist the swap program (Jupiter v6) and
// the small set of well-known Solana system programs Jupiter uses
// for ATA creation and wSOL handling.
//
// Exported for offline unit tests.
export function validateJupiterInstructions(swapData, chain) {
  if (!swapData?.swapInstruction?.programId) {
    return { valid: false, reason: 'missing_swap_instruction_programId' };
  }
  if (!isAllowedSwapProgram(chain, swapData.swapInstruction.programId)) {
    return {
      valid: false,
      reason: `swap_program_not_allowlisted: ${swapData.swapInstruction.programId}`,
    };
  }
  const ancillary = [
    ...(Array.isArray(swapData.setupInstructions) ? swapData.setupInstructions : []),
    ...(swapData.cleanupInstruction ? [swapData.cleanupInstruction] : []),
  ];
  for (const ix of ancillary) {
    if (!ix?.programId) {
      return { valid: false, reason: 'ancillary_instruction_missing_programId' };
    }
    if (!isAllowedAncillaryProgram(chain, ix.programId)) {
      return {
        valid: false,
        reason: `ancillary_program_not_allowlisted: ${ix.programId}`,
      };
    }
  }
  return { valid: true };
}

// Resolve Jupiter-provided LUT addresses into AddressLookupTableAccount objects.
// These let vaultTransactionCreate compress the inner message: accounts present
// in a LUT take 1 byte (index) instead of 32 bytes (pubkey), which is what keeps
// the Squads meta-tx under Solana's 1232-byte limit.
async function resolveLookupTables(connection, addresses, ctx) {
  if (!Array.isArray(addresses) || addresses.length === 0) return [];
  const start = Date.now();
  const results = await Promise.all(
    addresses.map((addr) =>
      connection
        .getAddressLookupTable(new PublicKey(addr))
        .then((r) => r?.value ?? null)
        .catch(() => null),
    ),
  );
  const resolved = results.filter((r) => r instanceof AddressLookupTableAccount);
  stepLog(ctx, `lookup_tables resolved=${resolved.length}/${addresses.length} (${Date.now() - start}ms)`);
  return resolved;
}

// ============================================================
// Squads Transaction Building
// ============================================================

async function buildAndSubmitSquadsTx(env, instructions, { dryRun = false, ctx, lookupTableAccounts = [] } = {}) {
  const { connection, multisigPda, vaultPda, signer, vaultIndex } = env;
  stepLog(
    ctx,
    `squads_init: multisig=${shortAddr(multisigPda)} vault=${shortAddr(vaultPda)} vaultIndex=${vaultIndex} instructions=${instructions.length} luts=${lookupTableAccounts.length}`,
  );

  // Get current multisig state for transaction index
  const multisigAccount = await withStep('rpc multisig.fromAccountAddress', ctx, () =>
    multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda),
  );
  const transactionIndex = Number(multisigAccount.transactionIndex) + 1;
  const transactionIndexBN = BigInt(transactionIndex);
  stepLog(ctx, `multisig_state: txIndex=${transactionIndex} threshold=${Number(multisigAccount.threshold)}`);

  // Build transaction message from Jupiter instructions
  const blockhash = await withStep('rpc getLatestBlockhash (inner)', ctx, () => connection.getLatestBlockhash());
  stepLog(ctx, `blockhash(inner)=${shortAddr(blockhash.blockhash)} lastValidBlock=${blockhash.lastValidBlockHeight}`);
  const txMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash.blockhash,
    instructions,
  });

  // Count ephemeral signers needed (instructions referencing the vault as signer
  // that aren't the vault itself)
  const ephemeralSigners = 0;

  // 1. Create vault transaction
  // addressLookupTableAccounts is what compresses the inner swap message:
  // without it, every Jupiter-referenced account costs 32 bytes inside the
  // meta-tx and routes like $YzY overflow the 1232-byte limit.
  const createTxIx = multisig.instructions.vaultTransactionCreate({
    multisigPda,
    transactionIndex: transactionIndexBN,
    creator: signer.publicKey,
    vaultIndex,
    ephemeralSigners,
    transactionMessage: txMessage,
    addressLookupTableAccounts: lookupTableAccounts,
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
  let metaTx;
  try {
    const metaMessage = new TransactionMessage({
      payerKey: signer.publicKey,
      recentBlockhash: blockhash.blockhash,
      instructions: [createTxIx, createProposalIx, approveIx],
    }).compileToV0Message();

    metaTx = new VersionedTransaction(metaMessage);
    metaTx.sign([signer]);
  } catch (serErr) {
    const totalDataBytes = instructions.reduce((sum, ix) => sum + ix.data.length, 0);
    const errMsg = `Squads transaction build failed (${instructions.length} instructions, ${totalDataBytes} bytes data): ${serErr.message}`;
    stepLog(ctx, `ERROR meta_compile: ${errMsg}`);
    log('error', 'execute-trade-solana', errMsg);
    throw new Error(errMsg);
  }
  const metaSize = metaTx.serialize().length;
  stepLog(ctx, `meta_tx signed signer=${shortAddr(signer.publicKey)} size=${metaSize}B (create+propose+approve)`);

  // Solana network packet limit is 1232 bytes. RPC simulation rejects oversized
  // versioned transactions with a generic error; gating here gives an actionable
  // classification before we burn an RPC call.
  if (metaSize > 1232) {
    const errMsg = `Squads meta-tx oversized: ${metaSize}B > 1232B limit (instructions=${instructions.length}, luts=${lookupTableAccounts.length})`;
    stepLog(ctx, `ERROR tx_too_large: ${errMsg}`);
    log('error', 'execute-trade-solana', errMsg);
    throw new Error(`tx_too_large: ${errMsg}`);
  }

  // Dry run: return signed tx data without broadcasting
  if (dryRun) {
    stepLog(ctx, `dry_run: returning without send`);
    return {
      status: 'dry_run',
      squadsTransactionIndex: transactionIndex,
      signerAddress: signer.publicKey.toString(),
      vaultAddress: vaultPda.toString(),
      instructionCount: instructions.length,
      threshold: Number(multisigAccount.threshold),
      serializedTxLength: metaSize,
    };
  }

  stepLog(ctx, `sending meta tx to RPC`);
  const metaSig = await withStep('rpc sendTransaction(meta)', ctx, () =>
    connection.sendTransaction(metaTx, { skipPreflight: false }),
  );
  stepLog(ctx, `meta_sent sig=${shortAddr(metaSig)}, confirming`);
  await withStep('rpc confirmTransaction(meta)', ctx, () =>
    connection.confirmTransaction({
      signature: metaSig,
      blockhash: blockhash.blockhash,
      lastValidBlockHeight: blockhash.lastValidBlockHeight,
    }),
  );
  stepLog(ctx, `meta_confirmed sig=${shortAddr(metaSig)}`);

  // 4. Check threshold — if met, execute
  const threshold = Number(multisigAccount.threshold);
  if (threshold <= 1) {
    stepLog(ctx, `executing on-chain (threshold=${threshold})`);
    const execStart = Date.now();
    try {
      const { instruction: executeTxIx, lookupTableAccounts } = await withStep(
        'rpc vaultTransactionExecute (build)',
        ctx,
        () =>
          multisig.instructions.vaultTransactionExecute({
            connection,
            multisigPda,
            transactionIndex: transactionIndexBN,
            member: signer.publicKey,
          }),
      );
      stepLog(ctx, `exec instruction built lookup_tables=${lookupTableAccounts?.length ?? 0}`);

      const execBlockhash = await withStep('rpc getLatestBlockhash (exec)', ctx, () => connection.getLatestBlockhash());
      stepLog(ctx, `blockhash(exec)=${shortAddr(execBlockhash.blockhash)}`);

      const execMessage = new TransactionMessage({
        payerKey: signer.publicKey,
        recentBlockhash: execBlockhash.blockhash,
        instructions: [executeTxIx],
      }).compileToV0Message(lookupTableAccounts);

      const execTx = new VersionedTransaction(execMessage);
      execTx.sign([signer]);
      stepLog(ctx, `exec_tx signed size=${execTx.serialize().length}B, sending`);

      const execSig = await withStep('rpc sendTransaction(exec)', ctx, () =>
        connection.sendTransaction(execTx, { skipPreflight: false }),
      );
      stepLog(ctx, `exec_sent sig=${shortAddr(execSig)}, confirming`);
      await withStep('rpc confirmTransaction(exec)', ctx, () =>
        connection.confirmTransaction({
          signature: execSig,
          blockhash: execBlockhash.blockhash,
          lastValidBlockHeight: execBlockhash.lastValidBlockHeight,
        }),
      );
      stepLog(ctx, `executed sig=${execSig} (${Date.now() - execStart}ms)`);

      return {
        status: 'executed',
        txSignature: execSig,
        squadsTransactionIndex: transactionIndex,
      };
    } catch (execErr) {
      stepLog(
        ctx,
        `ERROR execute: ${execErr.message} (${Date.now() - execStart}ms) — keeping as queued tx#${transactionIndex}`,
      );
      log(
        'warn',
        'execute-trade-solana',
        `Proposed and approved but execution failed (tx #${transactionIndex}): ${execErr.message}`,
      );
      return {
        status: 'queued_in_squads',
        txSignature: metaSig,
        squadsTransactionIndex: transactionIndex,
        note: `Proposed and approved but execution failed: ${execErr.message}`,
      };
    }
  }

  stepLog(ctx, `queued_in_squads tx#${transactionIndex} threshold=${threshold} confirmations=1`);
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

async function executeBuy(args, env, { dryRun = false } = {}) {
  const ctx = { action: 'buy', chain: args.chain, symbol: args.symbol };
  stepLog(
    ctx,
    `started amount=${args.amount} tier=${args.tier} slippage=${args.maxSlippage}% mint=${shortAddr(args.address)} dry_run=${dryRun}`,
  );
  const tokenMint = new PublicKey(args.address);
  const buyAmountUsd = parseFloat(args.amount);

  // Check vault's USDC balance
  const usdcBalance = await getTokenBalance(env.connection, USDC_MINT, env.vaultPda, ctx);
  const usdcBalanceFormatted = Number(usdcBalance) / 10 ** USDC_DECIMALS;
  stepLog(ctx, `usdc_balance: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`);

  if (usdcBalanceFormatted < buyAmountUsd) {
    log(
      'error',
      'execute-trade-solana',
      `Insufficient USDC for ${args.action} ${args.symbol} on ${args.chain}: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`,
    );
    return {
      status: 'failed',
      error: `Insufficient USDC: have ${usdcBalanceFormatted}, need ${buyAmountUsd}`,
    };
  }

  // Convert USD to USDC lamports
  const usdcLamports = BigInt(Math.round(buyAmountUsd * 10 ** USDC_DECIMALS));

  // Slippage in basis points
  const slippageBps = Math.round(parseFloat(args.maxSlippage) * 100);
  stepLog(ctx, `quote_request: src=USDC dst=${shortAddr(tokenMint)} amount=${usdcLamports} slippageBps=${slippageBps}`);

  // Get Jupiter quote
  const quote = await getJupiterQuote(USDC_MINT, tokenMint, usdcLamports, slippageBps, ctx);
  stepLog(ctx, `quote_ok: outAmount=${quote.outAmount} route_plan_len=${quote.routePlan?.length ?? '?'}`);

  // PR 2.6/2.7: fetch token decimals once — needed for both the
  // oracle cross-check below and the post-swap balance assertion.
  let tokenDecimals = null;
  let tokenProgramId = null;
  try {
    tokenProgramId = await detectTokenProgram(env.connection, tokenMint, ctx);
    const mintInfo = await getMint(env.connection, tokenMint, undefined, tokenProgramId);
    tokenDecimals = mintInfo.decimals;
    stepLog(ctx, `mint_info: decimals=${tokenDecimals}`);
  } catch (err) {
    stepLog(ctx, `mint_info_failed: ${err.message.slice(0, 80)} — oracle/post-swap checks degraded`);
  }

  // PR 2.7: independent oracle cross-check before signing. Catches
  // Jupiter-side quote manipulation and routing through stale pools.
  if (process.env.SKIP_PRICE_ORACLE !== 'true' && tokenDecimals !== null) {
    const tokensOut = Number(BigInt(quote.outAmount)) / 10 ** tokenDecimals;
    const quotePrice = tokensOut > 0 ? buyAmountUsd / tokensOut : 0;
    const oracle = await fetchOraclePrice(args.chain, args.address);
    if (oracle === null) {
      stepLog(ctx, `oracle_skipped: no source agreement for ${shortAddr(tokenMint)} on ${args.chain}`);
    } else {
      const drift = evaluatePriceDrift({ quotePrice, oraclePrice: oracle.price });
      if (!drift.valid) {
        log(
          'critical',
          'execute-trade-solana',
          `BUY oracle_drift_exceeded src=${oracle.source} ${drift.reason} [chain=${args.chain} symbol=${args.symbol}]`,
        );
        return {
          status: 'failed',
          error: `oracle_drift_exceeded (${oracle.source}): ${drift.reason}`,
          action: 'buy',
          symbol: args.symbol,
          chain: args.chain,
        };
      }
      stepLog(
        ctx,
        `oracle_ok src=${oracle.source} quote=$${quotePrice} oracle=$${oracle.price} drift=${drift.driftPct.toFixed(2)}%`,
      );
    }
  }

  // Get swap instructions for the vault
  stepLog(ctx, `swap_instructions_request`);
  const swapData = await getJupiterSwapInstructions(quote, env.vaultPda, ctx);

  // Validate Jupiter response before deserialization
  if (!swapData?.swapInstruction) {
    log(
      'error',
      'execute-trade-solana',
      `Jupiter response missing swapInstruction for buy ${args.symbol} on ${args.chain} (keys: ${JSON.stringify(Object.keys(swapData || {}))})`,
    );
    return {
      status: 'failed',
      error: `Jupiter response missing swapInstruction (keys: ${JSON.stringify(Object.keys(swapData || {}))})`,
      action: 'buy',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // PR 2.3: hard-allowlist every instruction's programId. If Jupiter
  // is compromised it could inject an attacker-controlled setup
  // instruction that drains the vault before the legit swap runs.
  const progCheck = validateJupiterInstructions(swapData, args.chain);
  if (!progCheck.valid) {
    log(
      'critical',
      'execute-trade-solana',
      `BUY ${progCheck.reason} for ${args.symbol} on ${args.chain} — refusing to sign`,
    );
    return {
      status: 'failed',
      error: `aggregator_program_not_allowlisted: ${progCheck.reason}`,
      action: 'buy',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // Combine all instructions
  let allInstructions;
  try {
    allInstructions = [];
    if (swapData.setupInstructions) {
      allInstructions.push(...swapData.setupInstructions.map(deserializeInstruction));
    }
    allInstructions.push(deserializeInstruction(swapData.swapInstruction));
    if (swapData.cleanupInstruction) {
      allInstructions.push(deserializeInstruction(swapData.cleanupInstruction));
    }
  } catch (deserErr) {
    stepLog(ctx, `ERROR deserialize: ${deserErr.message}`);
    log(
      'error',
      'execute-trade-solana',
      `Failed to deserialize Jupiter instructions for buy ${args.symbol} on ${args.chain}: ${deserErr.message}`,
    );
    return {
      status: 'failed',
      error: `Failed to deserialize Jupiter instructions: ${deserErr.message}`,
      action: 'buy',
      symbol: args.symbol,
      chain: args.chain,
    };
  }
  stepLog(
    ctx,
    `instructions_built: total=${allInstructions.length} setup=${swapData.setupInstructions?.length ?? 0} swap=1 cleanup=${swapData.cleanupInstruction ? 1 : 0}`,
  );

  const lookupTableAccounts = await resolveLookupTables(env.connection, swapData.addressLookupTableAddresses, ctx);

  // PR 2.6: snapshot pre-swap balance + decimals so we can compute
  // actual_received post-confirmation. Failures degrade gracefully —
  // no balance check rather than blocking the trade.
  // tokenDecimals was fetched above (PR 2.6/2.7 shared). If that
  // failed we skip the post-swap snapshot too.
  let preSwapBalance = null;
  if (!dryRun && tokenDecimals !== null) {
    try {
      preSwapBalance = await getTokenBalance(env.connection, tokenMint, env.vaultPda, ctx);
      stepLog(ctx, `presnap: token_balance=${preSwapBalance}`);
    } catch (err) {
      stepLog(ctx, `presnap_failed: ${err.message.slice(0, 80)} — post-swap drift check disabled`);
    }
  }

  const result = await buildAndSubmitSquadsTx(env, allInstructions, { dryRun, ctx, lookupTableAccounts });
  stepLog(
    ctx,
    `buy done status=${result.status} sig=${result.txSignature || ''} txIndex=${result.squadsTransactionIndex || ''}`,
  );

  // PR 2.6: post-swap balance read.
  let actualReceived = null;
  if (!dryRun && result.status === 'executed' && preSwapBalance !== null && tokenDecimals !== null) {
    try {
      const postSwapBalance = await getTokenBalance(env.connection, tokenMint, env.vaultPda, ctx);
      const delta = postSwapBalance - preSwapBalance;
      const deltaPositive = delta < 0n ? 0n : delta;
      actualReceived = Number(deltaPositive) / 10 ** tokenDecimals;
      stepLog(ctx, `postsnap: token_balance=${postSwapBalance} delta=${delta} actual_received=${actualReceived}`);
    } catch (err) {
      stepLog(ctx, `postsnap_failed: ${err.message.slice(0, 80)}`);
    }
  }

  const quotedReceived = tokenDecimals !== null ? Number(BigInt(quote.outAmount)) / 10 ** tokenDecimals : null;

  return {
    ...result,
    action: 'buy',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    usdcSpent: buyAmountUsd,
    expectedTokens: quote.outAmount,
    quotedReceived,
    actualReceived,
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
    `started amount=${args.amount} slippage=${args.maxSlippage}% mint=${shortAddr(args.address)} dry_run=${dryRun}`,
  );
  const tokenMint = new PublicKey(args.address);

  // Get vault's token balance
  const tokenBalance = await getTokenBalance(env.connection, tokenMint, env.vaultPda, ctx);
  stepLog(ctx, `token_balance=${tokenBalance}`);

  if (tokenBalance === 0n) {
    return {
      status: 'failed',
      error: `No token balance found for ${args.symbol} in vault`,
    };
  }

  // Resolve mint decimals up front: callers (process-order.js partial sells)
  // pass amount in human-readable token units (e.g. "28.431870482749996" for an
  // 80% sell of 35.539...). BigInt() crashes on fractional strings, so convert
  // to integer base units via decimals before quoting. Also reused by the
  // oracle cross-check below.
  let sellTokenDecimals = null;
  try {
    const tokenProgramId = await detectTokenProgram(env.connection, tokenMint, ctx);
    const mintInfo = await getMint(env.connection, tokenMint, undefined, tokenProgramId);
    sellTokenDecimals = mintInfo.decimals;
    stepLog(ctx, `mint_info: decimals=${sellTokenDecimals}`);
  } catch (err) {
    stepLog(ctx, `mint_info_failed: ${err.message.slice(0, 80)}`);
  }

  let sellAmount;
  if (args.amount === 'all') {
    sellAmount = tokenBalance;
  } else {
    const amountNum = parseFloat(args.amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      return {
        status: 'failed',
        error: `Invalid sell amount: ${args.amount}`,
      };
    }
    // Already-integer base-units strings still parse correctly through this path
    // when decimals=0; otherwise we always treat amount as human-readable units
    // (the convention process-order.js uses for partial sells).
    if (sellTokenDecimals === null) {
      return {
        status: 'failed',
        error: `Cannot convert sell amount ${args.amount} to base units: mint decimals lookup failed`,
      };
    }
    // Math.floor — never sell more than the position holds.
    sellAmount = BigInt(Math.floor(amountNum * 10 ** sellTokenDecimals));
    if (sellAmount <= 0n) {
      return {
        status: 'failed',
        error: `Sell amount ${args.amount} rounds to 0 base units at decimals=${sellTokenDecimals}`,
      };
    }
    if (tokenBalance < sellAmount) {
      return {
        status: 'failed',
        error: `Insufficient token balance: have ${tokenBalance.toString()}, need ${sellAmount.toString()} (from ${args.amount})`,
      };
    }
  }
  stepLog(ctx, `sell_amount=${sellAmount} (${args.amount === 'all' ? 'full' : 'partial'})`);

  // Slippage in basis points
  const slippageBps = Math.round(parseFloat(args.maxSlippage) * 100);
  stepLog(ctx, `quote_request: src=${shortAddr(tokenMint)} dst=USDC amount=${sellAmount} slippageBps=${slippageBps}`);

  // Get Jupiter quote (token → USDC)
  const quote = await getJupiterQuote(tokenMint, USDC_MINT, sellAmount, slippageBps, ctx);
  stepLog(ctx, `quote_ok: outAmount=${quote.outAmount} route_plan_len=${quote.routePlan?.length ?? '?'}`);

  // PR 2.7: oracle cross-check on the SELL side. Effective price =
  // USDC out / token in (both human-readable).
  if (process.env.SKIP_PRICE_ORACLE !== 'true') {
    if (sellTokenDecimals !== null) {
      const usdcOut = Number(BigInt(quote.outAmount)) / 10 ** USDC_DECIMALS;
      const tokensIn = Number(sellAmount) / 10 ** sellTokenDecimals;
      const quotePrice = tokensIn > 0 ? usdcOut / tokensIn : 0;
      const oracle = await fetchOraclePrice(args.chain, args.address);
      if (oracle === null) {
        stepLog(ctx, `oracle_skipped: no source agreement for ${shortAddr(tokenMint)} on ${args.chain}`);
      } else {
        const drift = evaluatePriceDrift({ quotePrice, oraclePrice: oracle.price });
        if (!drift.valid) {
          log(
            'critical',
            'execute-trade-solana',
            `SELL oracle_drift_exceeded src=${oracle.source} ${drift.reason} [chain=${args.chain} symbol=${args.symbol}]`,
          );
          return {
            status: 'failed',
            error: `oracle_drift_exceeded (${oracle.source}): ${drift.reason}`,
            action: 'sell',
            symbol: args.symbol,
            chain: args.chain,
          };
        }
        stepLog(
          ctx,
          `oracle_ok src=${oracle.source} quote=$${quotePrice} oracle=$${oracle.price} drift=${drift.driftPct.toFixed(2)}%`,
        );
      }
    }
  }

  // Get swap instructions for the vault
  stepLog(ctx, `swap_instructions_request`);
  const swapData = await getJupiterSwapInstructions(quote, env.vaultPda, ctx);

  // Validate Jupiter response before deserialization
  if (!swapData?.swapInstruction) {
    log(
      'error',
      'execute-trade-solana',
      `Jupiter response missing swapInstruction for sell ${args.symbol} on ${args.chain} (keys: ${JSON.stringify(Object.keys(swapData || {}))})`,
    );
    return {
      status: 'failed',
      error: `Jupiter response missing swapInstruction (keys: ${JSON.stringify(Object.keys(swapData || {}))})`,
      action: 'sell',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // PR 2.3: same allowlist check as the buy flow.
  const progCheckSell = validateJupiterInstructions(swapData, args.chain);
  if (!progCheckSell.valid) {
    log(
      'critical',
      'execute-trade-solana',
      `SELL ${progCheckSell.reason} for ${args.symbol} on ${args.chain} — refusing to sign`,
    );
    return {
      status: 'failed',
      error: `aggregator_program_not_allowlisted: ${progCheckSell.reason}`,
      action: 'sell',
      symbol: args.symbol,
      chain: args.chain,
    };
  }

  // Combine all instructions
  let allInstructions;
  try {
    allInstructions = [];
    if (swapData.setupInstructions) {
      allInstructions.push(...swapData.setupInstructions.map(deserializeInstruction));
    }
    allInstructions.push(deserializeInstruction(swapData.swapInstruction));
    if (swapData.cleanupInstruction) {
      allInstructions.push(deserializeInstruction(swapData.cleanupInstruction));
    }
  } catch (deserErr) {
    stepLog(ctx, `ERROR deserialize: ${deserErr.message}`);
    log(
      'error',
      'execute-trade-solana',
      `Failed to deserialize Jupiter instructions for sell ${args.symbol} on ${args.chain}: ${deserErr.message}`,
    );
    return {
      status: 'failed',
      error: `Failed to deserialize Jupiter instructions: ${deserErr.message}`,
      action: 'sell',
      symbol: args.symbol,
      chain: args.chain,
    };
  }
  stepLog(
    ctx,
    `instructions_built: total=${allInstructions.length} setup=${swapData.setupInstructions?.length ?? 0} swap=1 cleanup=${swapData.cleanupInstruction ? 1 : 0}`,
  );

  const lookupTableAccounts = await resolveLookupTables(env.connection, swapData.addressLookupTableAddresses, ctx);

  // PR 2.6: snapshot pre-swap USDC balance (sells receive USDC).
  let preSwapUsdc = null;
  if (!dryRun) {
    try {
      preSwapUsdc = await getTokenBalance(env.connection, USDC_MINT, env.vaultPda, ctx);
      stepLog(ctx, `presnap: usdc_balance=${preSwapUsdc}`);
    } catch (err) {
      stepLog(ctx, `presnap_failed: ${err.message.slice(0, 80)} — post-swap drift check disabled`);
    }
  }

  const result = await buildAndSubmitSquadsTx(env, allInstructions, { dryRun, ctx, lookupTableAccounts });
  stepLog(
    ctx,
    `sell done status=${result.status} sig=${result.txSignature || ''} txIndex=${result.squadsTransactionIndex || ''}`,
  );

  const expectedUsdc = Number(quote.outAmount) / 10 ** USDC_DECIMALS;

  // PR 2.6: post-swap USDC balance read.
  let actualReceived = null;
  if (!dryRun && result.status === 'executed' && preSwapUsdc !== null) {
    try {
      const postSwapUsdc = await getTokenBalance(env.connection, USDC_MINT, env.vaultPda, ctx);
      const delta = postSwapUsdc - preSwapUsdc;
      const deltaPositive = delta < 0n ? 0n : delta;
      actualReceived = Number(deltaPositive) / 10 ** USDC_DECIMALS;
      stepLog(ctx, `postsnap: usdc_balance=${postSwapUsdc} delta=${delta} actual_received=${actualReceived}`);
    } catch (err) {
      stepLog(ctx, `postsnap_failed: ${err.message.slice(0, 80)}`);
    }
  }

  return {
    ...result,
    action: 'sell',
    symbol: args.symbol,
    chain: args.chain,
    tokenAddress: args.address,
    tokensSold: sellAmount.toString(),
    expectedUsdc: expectedUsdc.toFixed(2),
    quotedReceived: expectedUsdc,
    actualReceived,
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
    const opts = { dryRun: args.dryRun };
    const result = args.action === 'buy' ? await executeBuy(args, env, opts) : await executeSell(args, env, opts);

    // Safety: ensure no private key in output
    const output = JSON.stringify(result, null, 2);
    if (process.env.SQUADS_SIGNER_KEY && output.includes(process.env.SQUADS_SIGNER_KEY)) {
      log(
        'critical',
        'execute-trade-solana',
        `Private key detected in output for ${args.action} ${args.symbol} on ${args.chain} — aborting`,
      );
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

    log('critical', 'execute-trade-solana', `${args.action} ${args.symbol} on ${args.chain} failed: ${safeMsg}`);
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

// Only run main when executed directly
const isMainModule = process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/^.*\//, ''));
if (isMainModule) {
  main();
}
