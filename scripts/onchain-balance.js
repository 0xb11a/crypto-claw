// ============================================================
// onchain-balance.js — Lightweight cash-token balance reads (PR 2.4)
//
// Defangs threat #5 directly: portfolio_meta.cash_* could be poisoned
// (via a sync bug, prompt-injected agent, or DB tampering) so that
// "5% of cash" becomes a much larger USD ceiling than what's actually
// in the vault. PR 2.1's tier cap is the first line of defense; this
// is the second — read the actual on-chain USDC balance and refuse
// to execute if the DB drifts > 1% from on-chain.
//
// Why a separate helper instead of spawning portfolio-load: the full
// portfolio sync is 5-30s (DeBank/Helius + per-token DEXScreener
// pricing). We just need ONE balance call (~200-500ms), via the same
// RPC the executor already has.
// ============================================================

import 'dotenv/config';
import { createPublicClient, http, parseAbi, formatUnits } from 'viem';
import { Connection, PublicKey } from '@solana/web3.js';
import { getAssociatedTokenAddress, getAccount, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import { getChain, getCashToken, isEVM, isSolana, isAllowedRpcUrl } from './chains.js';

const ERC20_ABI = parseAbi(['function balanceOf(address) view returns (uint256)']);

// PR 2.8: defense-in-depth. Throw early if the RPC env is tampered
// — the same hostname check execute-trade-{evm,solana}.js does at
// signing time. Without this, PR 2.4's cash reconciliation could
// happily compare a poisoned-DB cash row against a tampered-RPC
// "balance" reading and decide they "agree".
function assertRpcAllowed(chainName, rpcUrl) {
  const mode = process.env.RPC_VALIDATION_MODE || 'strict';
  if (mode === 'skip') return;
  if (isAllowedRpcUrl(chainName, rpcUrl)) return;
  let host = '';
  try {
    host = new URL(rpcUrl).hostname;
  } catch {
    host = '<unparseable>';
  }
  if (mode === 'warn') return; // honor warn-only rollout flag
  throw new Error(`rpc_hostname_not_allowlisted: ${host} on ${chainName}`);
}

/**
 * EVM cash-token balance via direct contract call (no DeBank dep).
 * @param {string} chainName
 * @returns {Promise<number>} balance as a human-readable USD number
 */
async function fetchEvmCashBalance(chainName) {
  const chain = getChain(chainName);
  const safeAddress = process.env[chain.safe.addressEnv];
  const rpcUrl = process.env[chain.safe.rpcEnv];
  if (!safeAddress) throw new Error(`${chain.safe.addressEnv} not set`);
  if (!rpcUrl) throw new Error(`${chain.safe.rpcEnv} not set`);
  assertRpcAllowed(chainName, rpcUrl);

  const cashToken = getCashToken(chainName);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const balance = await client.readContract({
    address: cashToken.address,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [safeAddress],
  });
  return parseFloat(formatUnits(balance, cashToken.decimals));
}

/**
 * Solana cash-token balance via getTokenAccountBalance on the vault's
 * USDC ATA. Returns 0 if the ATA doesn't exist (e.g. fresh vault).
 * @param {string} chainName
 * @returns {Promise<number>}
 */
async function fetchSolanaCashBalance(chainName) {
  const chain = getChain(chainName);
  const rpcUrl = process.env[chain.squads.rpcEnv];
  if (!rpcUrl) throw new Error(`${chain.squads.rpcEnv} not set`);
  assertRpcAllowed(chainName, rpcUrl);

  // Vault address: prefer the explicit vault env, fall back to the
  // multisig PDA derivation that execute-trade-solana also uses.
  // Keeping the resolution local avoids a circular import.
  let vaultAddress = process.env[chain.squads.vaultEnv];
  if (!vaultAddress) {
    const multisigAddress = process.env[chain.squads.multisigEnv];
    if (!multisigAddress) {
      throw new Error(`${chain.squads.vaultEnv} or ${chain.squads.multisigEnv} not set`);
    }
    // Lazy import — only EVM users would normally have this loaded.
    const multisig = await import('@sqds/multisig');
    const [pda] = multisig.getVaultPda({
      multisigPda: new PublicKey(multisigAddress),
      index: chain.squads.vaultIndex ?? 0,
    });
    vaultAddress = pda.toBase58();
  }

  const cashToken = getCashToken(chainName);
  const connection = new Connection(rpcUrl, 'confirmed');
  const mint = new PublicKey(cashToken.address);
  const owner = new PublicKey(vaultAddress);

  // Detect token program (USDC is SPL Token, but Token-2022 mints exist).
  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`USDC mint not found at ${cashToken.address}`);
  const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  try {
    const ata = await getAssociatedTokenAddress(mint, owner, true, programId);
    const account = await getAccount(connection, ata, undefined, programId);
    return Number(account.amount) / 10 ** cashToken.decimals;
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('TokenAccountNotFoundError') || msg.includes('could not find account')) {
      return 0; // fresh vault, no USDC ever received
    }
    throw err;
  }
}

/**
 * Read the chain's cash-token balance from the configured Safe /
 * Squads vault.
 * @param {string} chainName
 * @returns {Promise<number>}
 */
export async function fetchOnchainCashBalance(chainName) {
  if (isEVM(chainName)) return fetchEvmCashBalance(chainName);
  if (isSolana(chainName)) return fetchSolanaCashBalance(chainName);
  throw new Error(`Unsupported chain for cash-balance read: ${chainName}`);
}

// ============================================================
// Generic token-balance read (PR 2.6) — used for the post-swap
// "did we actually receive what was quoted?" check.
// ============================================================

/**
 * EVM: read ERC-20 balance of `owner` for arbitrary token.
 */
async function fetchEvmTokenBalance(chainName, tokenAddress, owner, decimals) {
  const chain = getChain(chainName);
  const rpcUrl = process.env[chain.safe.rpcEnv];
  if (!rpcUrl) throw new Error(`${chain.safe.rpcEnv} not set`);
  assertRpcAllowed(chainName, rpcUrl);
  const client = createPublicClient({ transport: http(rpcUrl) });
  const balance = await client.readContract({
    address: tokenAddress,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [owner],
  });
  return parseFloat(formatUnits(balance, decimals));
}

/**
 * Solana: read SPL-token ATA balance for `owner` of arbitrary mint.
 * Returns 0 if the ATA doesn't exist (e.g. fresh buy hasn't created
 * it yet — treat as no holdings).
 */
async function fetchSolanaTokenBalance(chainName, mintAddress, owner, decimals) {
  const chain = getChain(chainName);
  const rpcUrl = process.env[chain.squads.rpcEnv];
  if (!rpcUrl) throw new Error(`${chain.squads.rpcEnv} not set`);
  assertRpcAllowed(chainName, rpcUrl);
  const connection = new Connection(rpcUrl, 'confirmed');
  const mint = new PublicKey(mintAddress);
  const ownerKey = new PublicKey(owner);

  const mintInfo = await connection.getAccountInfo(mint);
  if (!mintInfo) throw new Error(`Mint not found: ${mintAddress}`);
  const programId = mintInfo.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  try {
    const ata = await getAssociatedTokenAddress(mint, ownerKey, true, programId);
    const account = await getAccount(connection, ata, undefined, programId);
    return Number(account.amount) / 10 ** decimals;
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('TokenAccountNotFoundError') || msg.includes('could not find account')) {
      return 0;
    }
    throw err;
  }
}

/**
 * Generic token-balance read. Branches on chain.
 *
 * @param {string} chainName
 * @param {string} tokenAddress
 * @param {string} owner  Safe address (EVM) or vault pubkey (Solana)
 * @param {number} decimals
 * @returns {Promise<number>}  human-readable token amount
 */
export async function fetchOnchainTokenBalance(chainName, tokenAddress, owner, decimals) {
  if (isEVM(chainName)) return fetchEvmTokenBalance(chainName, tokenAddress, owner, decimals);
  if (isSolana(chainName)) return fetchSolanaTokenBalance(chainName, tokenAddress, owner, decimals);
  throw new Error(`Unsupported chain for token-balance read: ${chainName}`);
}

// ============================================================
// Pure drift predicate (PR 2.6) — given the quoted vs actual amounts
// from a completed swap, decide whether the drift is acceptable.
// Used to detect fee-on-transfer tokens, partial honeypots, and
// MEV/sandwich attacks that exceeded the slippage tolerance.
// ============================================================

/**
 * @param {object} input
 * @param {number} input.actualReceived   on-chain delta (post - pre)
 * @param {number} input.quotedReceived   what the aggregator quoted
 * @param {number} input.maxSlippagePct   the slippage cap we sent to the aggregator (5 or 2)
 * @param {number} [input.extraTolerancePct=0.5]  cushion for normal price wiggle
 * @returns {{ valid: boolean, driftPct: number, reason?: string }}
 */
export function evaluateReceivedDrift({ actualReceived, quotedReceived, maxSlippagePct, extraTolerancePct = 0.5 }) {
  if (!Number.isFinite(actualReceived) || actualReceived < 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_actual_received: ${actualReceived}` };
  }
  if (!Number.isFinite(quotedReceived) || quotedReceived <= 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_quoted_received: ${quotedReceived}` };
  }
  if (!Number.isFinite(maxSlippagePct) || maxSlippagePct < 0) {
    return { valid: false, driftPct: NaN, reason: `invalid_max_slippage_pct: ${maxSlippagePct}` };
  }

  // Drift in the BAD direction only (we received less than expected).
  // If we received MORE, that's a positive surprise — never failure.
  const shortfall = quotedReceived - actualReceived;
  const driftPct = (shortfall / quotedReceived) * 100;

  if (driftPct <= 0) return { valid: true, driftPct: 0 };

  const cap = maxSlippagePct + extraTolerancePct;
  if (driftPct > cap) {
    return {
      valid: false,
      driftPct,
      reason: `received_short: actual=${actualReceived} quoted=${quotedReceived} drift=${driftPct.toFixed(2)}% > slippage_cap+tolerance=${cap}%`,
    };
  }
  return { valid: true, driftPct };
}

/**
 * Pure predicate — given the DB cash and on-chain cash, decide whether
 * the order should proceed. Exported so process-order.js logic can be
 * unit-tested without spawning RPC calls.
 *
 * Drift = |db - onchain| / max(1, onchain) — using max(1, onchain)
 * stops a near-zero on-chain balance from making any positive DB
 * value look like infinite drift (the absolute-difference vs the cap
 * is what actually matters at low balances).
 *
 * @param {object} input
 * @param {number} input.dbCash       USD value from portfolio_meta
 * @param {number} input.onchainCash  USD value from on-chain RPC
 * @param {number} [input.maxDriftPct=1]   acceptable drift as percentage
 * @param {number} [input.minAbsoluteUsd=5]   skip drift check below this
 *   absolute USD floor (avoid alerting on dust differences when both
 *   numbers are tiny — the tier-cap PR 2.1 already protects)
 * @returns {{ valid: boolean, drift: number, reason?: string }}
 */
export function evaluateCashDrift({ dbCash, onchainCash, maxDriftPct = 1, minAbsoluteUsd = 5 }) {
  if (!Number.isFinite(dbCash) || dbCash < 0) {
    return { valid: false, drift: NaN, reason: `invalid_db_cash: ${dbCash}` };
  }
  if (!Number.isFinite(onchainCash) || onchainCash < 0) {
    return { valid: false, drift: NaN, reason: `invalid_onchain_cash: ${onchainCash}` };
  }

  const absDiff = Math.abs(dbCash - onchainCash);

  // Below the absolute floor, both numbers are dust — drift % is
  // noisy and not actionable.
  if (Math.max(dbCash, onchainCash) < minAbsoluteUsd) {
    return { valid: true, drift: 0 };
  }

  const driftPct = (absDiff / Math.max(1, onchainCash)) * 100;
  if (driftPct > maxDriftPct) {
    return {
      valid: false,
      drift: driftPct,
      reason: `cash_drift_too_large: db=$${dbCash.toFixed(2)} onchain=$${onchainCash.toFixed(2)} drift=${driftPct.toFixed(2)}% > ${maxDriftPct}%`,
    };
  }

  return { valid: true, drift: driftPct };
}
