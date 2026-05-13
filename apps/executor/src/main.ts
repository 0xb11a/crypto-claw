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
 *
 * ### Testability
 * The bootstrap logic lives in `runExecutor()` which accepts optional stream/env
 * overrides. The top-level `if (run-as-CLI)` guard calls `runExecutor()` with
 * real streams and `process.env`. Tests call `runExecutor()` directly with
 * injected streams so coverage is captured in-process by v8.
 */
import { Readable } from 'node:stream';
import { assertConfigValid } from '@cclaw/config';
import { readOrderFromStdin } from './order-input.js';
import { runPreflight, assertSignerKeysPresent } from './preflight.js';
import { executeTrade } from './execute-trade.js';

/** Classify an error message into a machine-readable kind. */
export function classifyError(message: string): string {
  if (message.includes('signer_balance_insufficient')) return 'signer_balance_insufficient';
  if (message.includes('slippage_exceeded')) return 'slippage_exceeded';
  if (message.includes('stale_price')) return 'stale_price';
  if (message.includes('SIGNER_KEY')) return 'missing_signer_key';
  if (message.includes('not_yet_implemented_real_mode')) return 'not_yet_implemented_real_mode';
  if (message.includes('order validation failed')) return 'order_validation_failed';
  // New error_kinds from real EVM SDK (P1c-ii)
  if (message.includes('rpc_hostname_not_allowlisted')) return 'rpc_hostname_not_allowlisted';
  if (message.includes('safe_propose_failed') || message.includes('proposeTransaction')) return 'safe_propose_failed';
  if (message.includes('oneinch_failed')) return 'oneinch_failed';
  if (message.includes('transaction_reverted') || message.includes('execution reverted')) return 'transaction_reverted';
  return 'executor_error';
}

/** Options bag for runExecutor — allows tests to inject streams and env. */
export interface RunExecutorOptions {
  /** Readable stream to read the order JSON from. Defaults to process.stdin. */
  stdin?: Readable;
  /** Writable to send the receipt JSON line to. Defaults to process.stdout. */
  stdout?: NodeJS.WritableStream;
  /** Writable to send warnings/debug output to. Defaults to process.stderr. */
  stderr?: NodeJS.WritableStream;
  /** Environment variables. Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
}

/**
 * Execute the full executor bootstrap: validate config, read order, preflight,
 * trade, emit receipt.
 *
 * Returns the receipt JSON string (already written to `stdout`).
 * Throws on any fatal error — the caller is responsible for printing the
 * failure receipt and setting the exit code.
 *
 * This function is the unit-testable core. The top-level CLI guard below
 * wraps it in a `.catch()` that writes the failure receipt to stdout and
 * calls `process.exit(1)`.
 *
 * @param options - Injectable streams and env for testing.
 * @returns Receipt JSON string (the same value written to stdout).
 */
export async function runExecutor(options: RunExecutorOptions = {}): Promise<string> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const env = options.env ?? process.env;

  // Step 1 — config validation (does NOT check for signer keys — ADR-0010).
  assertConfigValid(env);

  // Step 2 — warn loudly if stub mode is active.
  if (env['EXECUTOR_STUB_MODE'] === '1') {
    stderr.write('[WARN] ===================================================\n');
    stderr.write('[WARN] EXECUTOR_STUB_MODE=true — NO REAL TRADES WILL EXECUTE\n');
    stderr.write('[WARN] Do NOT run with this flag in production!\n');
    stderr.write('[WARN] ===================================================\n');
  }

  // Step 3 — read order from stdin.
  const order = await readOrderFromStdin(stdin);

  // Step 4 — signer keys check (fast, synchronous).
  assertSignerKeysPresent(order.chain, env);

  // Step 5 — preflight checks.
  await runPreflight(order, env);

  // Step 6 — execute trade (stub in P1c-i).
  const receipt = await executeTrade(order, env);

  // Step 7 — print receipt to stdout.
  const receiptJson = JSON.stringify(receipt) + '\n';
  stdout.write(receiptJson);
  return receiptJson;
}

// ---------------------------------------------------------------------------
// CLI entry point — only invoked when run as a standalone script.
// Tests import runExecutor() directly and never hit this branch.
//
// CJS guard: require.main === module is true only when Node spawned this file
// directly (i.e., `node dist/main.js`). When imported in tests (vitest), the
// module is required as a dependency, so this block is skipped.
// ---------------------------------------------------------------------------
if (require.main === module) {
  runExecutor()
    .then(() => {
      process.exit(0);
    })
    .catch((err: unknown) => {
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
}
