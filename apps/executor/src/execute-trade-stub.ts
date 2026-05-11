/**
 * execute-trade-stub.ts — Deterministic stub executor for P1c-i.
 *
 * Returns a fake receipt derived from the order ID so tests are stable.
 * Gated behind EXECUTOR_STUB_MODE=1 — throws `not_yet_implemented_real_mode`
 * if stub mode is off.
 *
 * OPERATOR WARNING: `EXECUTOR_STUB_MODE=true` is logged at startup.
 * If you see that log in production, flip EXECUTOR_STUB_MODE=0 immediately.
 *
 * P1c-ii replaces this file with the real Safe SDK implementation.
 *
 * @see SPEC §4 #4 — signer keys are present in env by the time this runs.
 */
import { createHash } from 'node:crypto';
import type { OrderInput, SuccessReceipt } from '@cclaw/execution';

/**
 * Derive a deterministic fake tx hash from the order id.
 * Uses sha256 so the output is stable across runs.
 */
function fakeTxHash(orderId: string): string {
  const hash = createHash('sha256').update(orderId).digest('hex');
  return '0x' + hash.padEnd(64, '0').slice(0, 64);
}

/**
 * Execute a trade in stub mode.
 *
 * Returns a deterministic SuccessReceipt. Every field is derived from
 * the order inputs so the caller can assert exact values in tests.
 *
 * @param order - The validated order to "execute".
 * @param env - Process environment (must contain EXECUTOR_STUB_MODE=1).
 * @returns Promise<SuccessReceipt>
 * @throws {Error} 'not_yet_implemented_real_mode' if EXECUTOR_STUB_MODE is not '1'.
 */
export async function executeTrade(
  order: OrderInput,
  env: Record<string, string | undefined>,
): Promise<SuccessReceipt> {
  const stubMode = env['EXECUTOR_STUB_MODE'];
  if (stubMode !== '1') {
    throw new Error('not_yet_implemented_real_mode');
  }

  return {
    status: 'executed',
    tx_hash: fakeTxHash(order.id),
    block_number: 1_000_000,
    gas_used: 50_000,
    actual_amount_in: order.amount,
    actual_amount_out: order.expected_amount_out ?? 0,
    slippage_bps: order.slippage_bps ?? 50,
    executed_at: new Date().toISOString(),
  };
}
