/**
 * execute-trade.ts — Dispatch layer for trade execution.
 *
 * Routing priority:
 *   1. EXECUTOR_STUB_MODE === '1'  → delegate to executeTradeStub (no real SDK import).
 *   2. chain === 'solana'          → dynamic import of execute-trade-solana.ts (P1c-iii).
 *   3. EVM chain                   → dynamic import of execute-trade-evm.ts to call real Safe SDK.
 *
 * The stub-mode short-circuit MUST happen before any real-SDK dynamic import.
 * This preserves CI paths where @safe-global/* or @sqds/multisig packages are not
 * installed — stub mode tests still pass without those SDKs present.
 *
 * @see apps/executor/src/execute-trade-stub.ts     — stub implementation
 * @see apps/executor/src/execute-trade-evm.ts      — real EVM Safe SDK implementation
 * @see apps/executor/src/execute-trade-solana.ts   — real Squads V4 SDK implementation (P1c-iii)
 * @see SPEC §4 #4 — signer keys present in env by the time this runs
 * @see ADR-0010    — executor subprocess isolation
 * @see ADR-0023    — signer env file mount
 */
import type { OrderInput, SuccessReceipt, FailureReceipt } from '@cclaw/execution';
import { executeTrade as executeTradeStub } from './execute-trade-stub.js';

/** Union of all receipt types this dispatcher can return. */
export type TradeResult = SuccessReceipt | FailureReceipt;

/**
 * Dispatch trade execution to the appropriate backend.
 *
 * Always short-circuits to stub when EXECUTOR_STUB_MODE === '1'.
 * For Solana in real mode returns a clean failure receipt.
 * For EVM in real mode dynamically imports execute-trade-evm.ts.
 *
 * @param order - Validated order from stdin.
 * @param env   - Full child process env (contains signer keys injected by worker).
 * @returns Receipt (success or failure).
 */
export async function executeTrade(order: OrderInput, env: Record<string, string | undefined>): Promise<TradeResult> {
  // ─── Step 1: stub-mode short-circuit (MUST precede any real-SDK import) ───
  if (env['EXECUTOR_STUB_MODE'] === '1') {
    return executeTradeStub(order, env);
  }

  // ─── Step 2: real Squads V4 SDK for Solana (P1c-iii) ────────────────────
  // Dynamic import ensures @sqds/multisig + @solana/web3.js are never loaded
  // in stub-mode CI environments that don't have these packages installed.
  if (order.chain === 'solana') {
    const { executeTradeSolana } = await import('./execute-trade-solana.js');
    return executeTradeSolana(order, env);
  }

  // ─── Step 3: real EVM Safe SDK (dynamic import gated by non-stub mode) ────
  // Dynamic import ensures @safe-global/* is never loaded in stub-mode CI.
  const { executeTradeEvm } = await import('./execute-trade-evm.js');
  return executeTradeEvm(order, env);
}
