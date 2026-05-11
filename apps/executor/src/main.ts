/**
 * apps/executor — Ephemeral subprocess spawned per order.
 *
 * Per ADR-0010, this is the ONLY process that may hold SAFE_SIGNER_KEY
 * and SQUADS_SIGNER_KEY in its env. It runs for the duration of a single
 * trade execution and then exits.
 *
 * This module deliberately does NOT call assertNoSignerKeysInEnv().
 *
 * Boot sequence (P1c-i):
 * 1. assertConfigValid — exits 78 on invalid config
 * 2. Warn visibly if EXECUTOR_STUB_MODE=1
 * 3. assertSignerKeysPresent — exits 1 if required signer key absent
 * 4. readOrderFromStdin — parse order JSON from stdin
 * 5. runPreflight — signer balance + slippage + stale price checks
 * 6. executeTrade — produce receipt (stub in P1c-i; real SDK in P1c-ii/iii)
 * 7. Print receipt JSON to stdout and exit 0
 *
 * On ANY error: print {status:'failed', error, error_kind} to stdout and exit 1.
 * ALL other output (preflight logs, debug info) goes to stderr.
 *
 * Note: process.env access is allowed in apps-star-src-main.ts per eslint.config.js
 * (boot entrypoint exception). This is intentional: executor is the one process
 * that holds signer keys.
 */
import { assertConfigValid } from '@cclaw/config';
import { readOrderFromStdin } from './order-input.js';
import { runPreflight, assertSignerKeysPresent } from './preflight.js';
import { executeTrade } from './execute-trade-stub.js';

/** Classify an error message into a machine-readable kind. */
function classifyError(message: string): string {
  if (message.includes('signer_balance_insufficient')) return 'signer_balance_insufficient';
  if (message.includes('slippage_exceeded')) return 'slippage_exceeded';
  if (message.includes('stale_price')) return 'stale_price';
  if (message.includes('SIGNER_KEY')) return 'missing_signer_key';
  if (message.includes('not_yet_implemented_real_mode')) return 'not_yet_implemented_real_mode';
  if (message.includes('order validation failed')) return 'order_validation_failed';
  return 'executor_error';
}

async function main(): Promise<void> {
  // Step 1 — config validation (does NOT check for signer keys — ADR-0010).
  assertConfigValid(process.env);

  // Step 2 — warn loudly if stub mode is active.
  if (process.env['EXECUTOR_STUB_MODE'] === '1') {
    process.stderr.write('[WARN] ===================================================\n');
    process.stderr.write('[WARN] EXECUTOR_STUB_MODE=true — NO REAL TRADES WILL EXECUTE\n');
    process.stderr.write('[WARN] Do NOT run with this flag in production!\n');
    process.stderr.write('[WARN] ===================================================\n');
  }

  // Step 3 — read order from stdin.
  const order = await readOrderFromStdin();

  // Step 4 — signer keys check (fast, synchronous).
  assertSignerKeysPresent(order.chain, process.env);

  // Step 5 — preflight checks.
  await runPreflight(order, process.env);

  // Step 6 — execute trade (stub in P1c-i).
  const receipt = await executeTrade(order, process.env);

  // Step 7 — print receipt to stdout and exit 0.
  process.stdout.write(JSON.stringify(receipt) + '\n');
  process.exit(0);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  const errorKind = classifyError(message);

  // All errors produce a failure receipt on stdout.
  const failureReceipt = {
    status: 'failed',
    error: message,
    error_kind: errorKind,
  };
  process.stdout.write(JSON.stringify(failureReceipt) + '\n');
  process.exit(1);
});
