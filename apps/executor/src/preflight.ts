/**
 * preflight.ts — Pre-execution validation checks.
 *
 * Implements the P1c-i pre-execution checks:
 *   1. assertSignerKeysPresent   — EVM: SAFE_SIGNER_KEY, Solana: SQUADS_SIGNER_KEY
 *   2. checkSignerBalance        — stub: returns ok always (P1c-ii wires real balance)
 *   3. checkSlippage             — mirrors legacy 5%/2% hardcodes from process-order.js
 *   4. checkStalePrice           — stub: returns ok always (P1c-ii wires real price check)
 *
 * Each check is a separate function so P1c-ii/iii can swap in real impls
 * without touching the main.ts flow.
 *
 * @see SPEC §9.7 — signer keys present check
 * @see scripts/process-order.js:171 — slippage limits source of truth
 */
import type { OrderInput } from '@cclaw/execution';

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
// 2. checkSignerBalance (stub — P1c-ii wires real balance check)
// ---------------------------------------------------------------------------

export interface SignerBalanceResult {
  ok: boolean;
  /** Human-readable message (e.g. 'balance ok (stub)') */
  message: string;
}

/**
 * Check that the signer account has sufficient native token balance for gas.
 *
 * P1c-i stub: always returns ok.
 * P1c-ii replaces this with a real RPC balance query.
 *
 * @param chain - Chain identifier.
 * @returns SignerBalanceResult — always { ok: true } in stub mode.
 */
export async function checkSignerBalance(_chain: string): Promise<SignerBalanceResult> {
  // P1c-i stub — real implementation lands in P1c-ii
  return { ok: true, message: 'balance ok (stub — P1c-ii wires real check)' };
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
// 4. checkStalePrice (stub — P1c-ii wires real price staleness check)
// ---------------------------------------------------------------------------

export interface StalePriceResult {
  ok: boolean;
  /** Reason if not ok. */
  reason?: string;
}

/**
 * Check whether the order's entry price has drifted too far from current price.
 *
 * P1c-i stub: always returns ok.
 * P1c-ii replaces with real DEXScreener/Birdeye price fetch + >10% drift check.
 *
 * @param order - The order to check.
 * @returns StalePriceResult — always { ok: true } in stub mode.
 */
export async function checkStalePrice(_order: OrderInput): Promise<StalePriceResult> {
  // P1c-i stub — real implementation lands in P1c-ii
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

  // 2. Signer balance (stub — always ok in P1c-i)
  const balance = await checkSignerBalance(order.chain);
  if (!balance.ok) {
    throw new Error(`[preflight] signer_balance_insufficient: ${balance.message}`);
  }

  // 3. Slippage
  const slippage = checkSlippage(order);
  if (!slippage.ok) {
    throw new Error(`[preflight] slippage_exceeded: ${slippage.reason}`);
  }

  // 4. Stale price (stub — always ok in P1c-i)
  const stalePrice = await checkStalePrice(order);
  if (!stalePrice.ok) {
    throw new Error(`[preflight] stale_price: ${stalePrice.reason}`);
  }
}
