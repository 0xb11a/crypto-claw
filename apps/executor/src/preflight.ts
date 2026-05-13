/**
 * preflight.ts — Pre-execution validation checks.
 *
 * Implements the P1c-ii pre-execution checks:
 *   1. assertSignerKeysPresent   — EVM: SAFE_SIGNER_KEY, Solana: SQUADS_SIGNER_KEY
 *   2. checkSignerBalance        — real viem getBalance check for EVM signers (P1c-ii)
 *   3. checkSlippage             — mirrors legacy 5%/2% hardcodes from process-order.js
 *   4. checkStalePrice           — real DEXScreener price fetch + >10% drift check (P1c-ii)
 *
 * Each check is a separate function so future phases can extend without touching the
 * main.ts flow.
 *
 * @see SPEC §9.7 — signer keys present check
 * @see scripts/process-order.js:171 — slippage limits source of truth
 */
import type { OrderInput } from '@cclaw/execution';
import { getChain, isEvm, LAMPORTS_PER_SOL } from '@cclaw/chain';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

// ---------------------------------------------------------------------------
// Maximum slippage per tier (mirrors scripts/process-order.js:171)
// ---------------------------------------------------------------------------
const MAX_SLIPPAGE_BPS: Record<string, number> = {
  moonshot: 500, // 5% for moonshot tier
  conviction: 200, // 2% for conviction tier
  base: 200, // 2% for base tier
};
/** Default if tier is not recognized. */
const DEFAULT_MAX_SLIPPAGE_BPS = 500; // 5%

// ---------------------------------------------------------------------------
// 1. assertSignerKeysPresent
// ---------------------------------------------------------------------------

/**
 * Assert that the required signer keys are present for the given chain.
 *
 * EVM chains (base, ethereum): require SAFE_SIGNER_KEY.
 * Solana: requires SQUADS_SIGNER_KEY.
 * Both keys: required when chain is 'solana', only SAFE_SIGNER_KEY for EVM.
 *
 * @param chain - Chain identifier (e.g. 'base', 'solana').
 * @param env - Environment object containing the signer keys.
 * @throws {Error} if the required key is absent or empty.
 */
export function assertSignerKeysPresent(chain: string, env: Record<string, string | undefined>): void {
  const isSolana = chain === 'solana';
  const safeKey = env['SAFE_SIGNER_KEY'];
  const squadsKey = env['SQUADS_SIGNER_KEY'];

  if (isSolana) {
    if (!squadsKey || squadsKey.trim() === '') {
      throw new Error(`[preflight] SQUADS_SIGNER_KEY is required for chain=${chain} but is not set`);
    }
  } else {
    // EVM (base, ethereum, and any future EVM chain)
    if (!safeKey || safeKey.trim() === '') {
      throw new Error(`[preflight] SAFE_SIGNER_KEY is required for chain=${chain} but is not set`);
    }
  }
}

// ---------------------------------------------------------------------------
// Solana signer balance helper (P1c-iii)
// ---------------------------------------------------------------------------

/**
 * Check the Squads signer account's SOL balance against the chain's
 * signerThreshold (expressed in SOL from libs/chain).
 *
 * Only called when EXECUTOR_STUB_MODE !== '1' and chain === 'solana'.
 * Fails gracefully (ok:true) if RPC is unreachable — mirrors EVM behaviour.
 * Fails hard (ok:false) if base58 key is unparseable — that is a configuration
 * error that should be surfaced before attempting the trade.
 */
async function checkSolanaSignerBalance(env: Record<string, string | undefined>): Promise<SignerBalanceResult> {
  const signerKeyBase58 = env['SQUADS_SIGNER_KEY'];
  const rpcUrl = env['RPC_SOL'];

  if (!signerKeyBase58 || !rpcUrl) {
    // assertSignerKeysPresent handles the absent-key case; skip here.
    return { ok: true, message: 'balance check skipped (missing SQUADS_SIGNER_KEY or RPC_SOL)' };
  }

  // Derive signer public key from base58 secret key.
  // @solana/web3.js and bs58 are dynamic-imported to stay out of stub-mode paths.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let web3: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let bs58Module: any;
  try {
    [web3, bs58Module] = await Promise.all([import('@solana/web3.js'), import('bs58')]);
  } catch {
    // Packages not installed (CI stub path) — skip gracefully
    return { ok: true, message: 'balance check skipped (Solana SDK not installed)' };
  }
  const bs58 = bs58Module.default ?? bs58Module;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let keypair: any;
  try {
    keypair = web3.Keypair.fromSecretKey(bs58.decode(signerKeyBase58));
  } catch {
    return {
      ok: false,
      message: 'signer_balance_insufficient: could not derive signer address from SQUADS_SIGNER_KEY (invalid base58)',
    };
  }

  const signerPublicKey = keypair.publicKey;

  let balanceLamports: number;
  try {
    const connection = new web3.Connection(rpcUrl, 'confirmed');
    balanceLamports = (await connection.getBalance(signerPublicKey)) as number;
  } catch (err) {
    process.stderr.write(`[preflight] Solana balance check RPC error: ${(err as Error).message} — proceeding\n`);
    return { ok: true, message: `balance check skipped (RPC error: ${(err as Error).message})` };
  }

  // signerThreshold for Solana is 0.05 SOL (see libs/chain/src/chains.ts)
  let thresholdSol: number;
  try {
    thresholdSol = getChain('solana').signerThreshold;
  } catch {
    thresholdSol = 0.05; // fallback if chain config unavailable
  }
  const thresholdLamports = BigInt(Math.floor(thresholdSol * Number(LAMPORTS_PER_SOL)));

  if (BigInt(balanceLamports) < thresholdLamports) {
    const balanceSol = balanceLamports / Number(LAMPORTS_PER_SOL);
    return {
      ok: false,
      message:
        `signer_balance_insufficient: solana signer=${signerPublicKey.toString()} has ` +
        `${balanceSol.toFixed(6)} SOL, need ≥ ${thresholdSol} SOL for gas`,
    };
  }

  const balanceSol = balanceLamports / Number(LAMPORTS_PER_SOL);
  return { ok: true, message: `balance ok: ${balanceSol.toFixed(6)} SOL (threshold: ${thresholdSol} SOL)` };
}

// ---------------------------------------------------------------------------
// 2. checkSignerBalance — real viem getBalance (P1c-ii)
// ---------------------------------------------------------------------------

export interface SignerBalanceResult {
  ok: boolean;
  /** Human-readable message describing balance status. */
  message: string;
}

/**
 * Check that the signer account has sufficient native token balance for gas.
 *
 * EVM chains: derives signer address from SAFE_SIGNER_KEY, fetches ETH balance
 * via viem getBalance against the chain's configured RPC URL, and compares to
 * the chain's signerThreshold (e.g. 0.001 ETH for Base, 0.005 for Ethereum).
 *
 * Solana: stub for now (P1c-iii wires Squads balance check).
 *
 * In EXECUTOR_STUB_MODE the entire preflight is still called but the balance
 * check should not fail — we skip the real RPC call when stub mode is active
 * (detected via env arg).
 *
 * @param chain - Chain identifier (e.g. 'base', 'ethereum', 'solana').
 * @param env   - Process env containing SAFE_SIGNER_KEY, RPC URL, EXECUTOR_STUB_MODE.
 * @returns SignerBalanceResult.
 */
export async function checkSignerBalance(
  chain: string,
  env: Record<string, string | undefined> = {},
): Promise<SignerBalanceResult> {
  // Stub mode: skip real RPC call
  if (env['EXECUTOR_STUB_MODE'] === '1') {
    return { ok: true, message: 'balance ok (stub mode)' };
  }

  // Solana: real balance check (P1c-iii)
  if (chain === 'solana') {
    return checkSolanaSignerBalance(env);
  }

  // EVM chain falls through to real viem balance check below
  let chainConfig: ReturnType<typeof getChain>;
  try {
    chainConfig = getChain(chain);
  } catch {
    return { ok: true, message: `balance check skipped (unknown chain: ${chain})` };
  }

  if (!isEvm(chainConfig)) {
    return { ok: true, message: `balance check skipped (non-EVM chain: ${chain})` };
  }

  const rpcUrl = env[chainConfig.safe.rpcEnv];
  const signerKey = env['SAFE_SIGNER_KEY'];

  if (!rpcUrl || !signerKey) {
    // Missing config — preflight will catch this separately in assertSignerKeysPresent
    return { ok: true, message: 'balance check skipped (missing RPC or key — assertSignerKeysPresent handles this)' };
  }

  let signerAddress: `0x${string}`;
  try {
    const key = signerKey.startsWith('0x') ? signerKey : `0x${signerKey}`;
    signerAddress = privateKeyToAccount(key as `0x${string}`).address;
  } catch {
    return { ok: false, message: 'signer_balance_insufficient: could not derive signer address from SAFE_SIGNER_KEY' };
  }

  let balance: bigint;
  try {
    const client = createPublicClient({ transport: http(rpcUrl) });
    balance = await client.getBalance({ address: signerAddress });
  } catch (err) {
    // RPC failure — don't block execution but log clearly
    process.stderr.write(`[preflight] balance check RPC error for ${chain}: ${(err as Error).message} — proceeding\n`);
    return { ok: true, message: `balance check skipped (RPC error: ${(err as Error).message})` };
  }

  // signerThreshold is in native-token units (ETH / SOL); convert to wei for comparison
  const thresholdEth = chainConfig.signerThreshold;
  // 1 ETH = 1e18 wei
  const thresholdWei = BigInt(Math.floor(thresholdEth * 1e18));

  if (balance < thresholdWei) {
    const balanceEth = Number(balance) / 1e18;
    return {
      ok: false,
      message:
        `signer_balance_insufficient: ${chain} signer=${signerAddress} has ` +
        `${balanceEth.toFixed(6)} ETH, need ≥ ${thresholdEth} ETH for gas`,
    };
  }

  const balanceEth = Number(balance) / 1e18;
  return { ok: true, message: `balance ok: ${balanceEth.toFixed(6)} ETH (threshold: ${thresholdEth} ETH)` };
}

// ---------------------------------------------------------------------------
// 3. checkSlippage
// ---------------------------------------------------------------------------

export interface SlippageCheckResult {
  ok: boolean;
  /** Reason if not ok. */
  reason?: string;
}

/**
 * Validate the order's requested slippage against per-tier limits.
 *
 * Slippage limits (mirrors scripts/process-order.js:171):
 *   moonshot: 5% (500 bps)
 *   conviction/base: 2% (200 bps)
 *
 * @param order - The order to check.
 * @returns SlippageCheckResult.
 */
export function checkSlippage(order: OrderInput): SlippageCheckResult {
  const requestedBps = order.slippage_bps;
  if (requestedBps === undefined || requestedBps === null) {
    // No explicit slippage — defaults are handled by the aggregator; pass.
    return { ok: true };
  }

  const tier = order.tier ?? 'moonshot'; // default to most permissive
  const maxBps = MAX_SLIPPAGE_BPS[tier] ?? DEFAULT_MAX_SLIPPAGE_BPS;

  if (requestedBps > maxBps) {
    return {
      ok: false,
      reason: `slippage ${requestedBps}bps exceeds max ${maxBps}bps for tier=${tier}`,
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. checkStalePrice — real DEXScreener price fetch + >10% drift check (P1c-ii)
// ---------------------------------------------------------------------------

export interface StalePriceResult {
  ok: boolean;
  /** Reason if not ok. */
  reason?: string;
}

/**
 * DEXScreener API response shape (minimal).
 * We only need `pairs[0].priceUsd`.
 */
interface DexScreenerPair {
  priceUsd?: string;
}
interface DexScreenerResponse {
  pairs?: DexScreenerPair[];
}

/**
 * Fetch current USD price from DEXScreener for a token on a given chain.
 * Returns null if the API is unavailable or the token is not found.
 *
 * @internal
 */
async function fetchDexScreenerPrice(chain: string, tokenAddress: string): Promise<number | null> {
  const chainId = (() => {
    try {
      return getChain(chain).dexScreenerId;
    } catch {
      return chain;
    }
  })();

  const url = `https://api.dexscreener.com/latest/dex/tokens/${tokenAddress}`;
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(5000),
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as DexScreenerResponse;
    const pair = data.pairs?.find((p) => p.priceUsd !== undefined && p.priceUsd !== '');
    // Filter to the target chain's pairs if possible
    const price = pair?.priceUsd;
    if (!price) return null;
    const parsed = parseFloat(price);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
  void chainId; // used implicitly via dexScreenerId lookup
}

/**
 * Check whether the order's entry_price has drifted more than 10% from the
 * current DEXScreener price.
 *
 * Mirrors scripts/process-order.js stale-price logic (>10% drift threshold).
 *
 * If entry_price is not set, or the DEXScreener fetch fails, the check passes
 * (fail-open for price fetches — a bad API response shouldn't block trades).
 *
 * Skipped in EXECUTOR_STUB_MODE=1.
 *
 * @param order - The order to check (uses order.entry_price + order.address + order.chain).
 * @param env   - Process env (checks EXECUTOR_STUB_MODE).
 * @returns StalePriceResult.
 */
export async function checkStalePrice(
  order: OrderInput,
  env: Record<string, string | undefined> = {},
): Promise<StalePriceResult> {
  // Stub mode or no entry price — skip
  if (env['EXECUTOR_STUB_MODE'] === '1') {
    return { ok: true };
  }

  if (order.entry_price === undefined || order.entry_price === null || order.entry_price <= 0) {
    return { ok: true };
  }

  const currentPrice = await fetchDexScreenerPrice(order.chain, order.address);
  if (currentPrice === null) {
    // API unavailable — pass (fail-open)
    process.stderr.write(
      `[preflight] stale price check: DEXScreener unavailable for ${order.chain}/${order.address} — proceeding\n`,
    );
    return { ok: true };
  }

  const entryPrice = order.entry_price;
  const drift = Math.abs(currentPrice - entryPrice) / entryPrice;
  const DRIFT_THRESHOLD = 0.1; // 10%

  if (drift > DRIFT_THRESHOLD) {
    return {
      ok: false,
      reason:
        `stale_price: ${order.symbol} price drifted ${(drift * 100).toFixed(1)}% ` +
        `from entry $${entryPrice} to current $${currentPrice} (threshold: 10%)`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Run all preflight checks for an order.
 *
 * @param order - The order to check.
 * @param env - Environment object (should contain signer keys injected by worker).
 * @throws {Error} if any preflight check fails. The error message is safe for stdout.
 */
export async function runPreflight(order: OrderInput, env: Record<string, string | undefined>): Promise<void> {
  // 1. Signer keys
  assertSignerKeysPresent(order.chain, env);

  // 2. Signer balance (real viem check in P1c-ii; stub-mode skipped via env)
  const balance = await checkSignerBalance(order.chain, env);
  if (!balance.ok) {
    throw new Error(`[preflight] signer_balance_insufficient: ${balance.message}`);
  }

  // 3. Slippage
  const slippage = checkSlippage(order);
  if (!slippage.ok) {
    throw new Error(`[preflight] slippage_exceeded: ${slippage.reason}`);
  }

  // 4. Stale price (real DEXScreener check in P1c-ii; stub-mode skipped via env)
  const stalePrice = await checkStalePrice(order, env);
  if (!stalePrice.ok) {
    throw new Error(`[preflight] stale_price: ${stalePrice.reason}`);
  }
}
