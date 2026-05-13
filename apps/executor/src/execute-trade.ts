/**
 * execute-trade.ts — Dispatch layer for trade execution.
 *
 * Routing priority:
 *   1. EXECUTOR_STUB_MODE === '1'  → delegate to executeTradeStub (no real SDK import).
 *   2. chain === 'solana'          → return { status:'failed', error_kind:'not_yet_implemented_real_mode' }
 *                                    (P1c-iii drops in Squads SDK).
 *   3. EVM chain                   → dynamic import of execute-trade-evm.ts to call real Safe SDK.
 *
 * The stub-mode short-circuit MUST happen before any real-SDK dynamic import.
 * This preserves CI paths where @safe-global/* packages are not installed —
 * stub mode tests still pass without Safe SDK present.
 *
 * @see apps/executor/src/execute-trade-stub.ts — stub implementation
 * @see apps/executor/src/execute-trade-evm.ts  — real EVM Safe SDK implementation
 * @see SPEC §4 #4 — signer keys present in env by the time this runs
 * @see ADR-0010    — executor subprocess isolation
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

  // ─── Step 2: Solana stub (P1c-iii) ────────────────────────────────────────
  if (order.chain === 'solana') {
    return {
      status: 'failed',
      error: 'Solana / Squads execution not yet implemented in real mode (P1c-iii)',
      error_kind: 'not_yet_implemented_real_mode',
    };
  }

  // ─── Step 3: real EVM Safe SDK (dynamic import gated by non-stub mode) ────
  // Dynamic import ensures @safe-global/* is never loaded in stub-mode CI.
  const { executeTradeEvm } = await import('./execute-trade-evm.js');
  return executeTradeEvm(order, env);
}
