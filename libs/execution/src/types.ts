/**
 * Shared types for the execution pipeline (libs/execution).
 *
 * These are the Zod schemas + TypeScript types used by:
 *  - `spawn-executor.ts` (input encoding)
 *  - `receipt-parser.ts` (output parsing)
 *  - `apps/executor` (input reading + receipt emission)
 *
 * SPEC §4 #4 — signer keys are never in this module's scope.
 * SPEC §4 #6 — these schemas are runtime-validated at the boundary.
 */
import { z } from 'zod';

// ---------------------------------------------------------------------------
// OrderInput — the JSON written to the executor's stdin
// ---------------------------------------------------------------------------

/**
 * Zod schema for the order object sent to the executor child process.
 * Only the fields the executor needs to build and sign a transaction.
 */
export const OrderInputSchema = z.object({
  /** Database order ID (used for deterministic stub hashes). */
  id: z.string().min(1),
  /** Trade action: 'buy' or 'sell'. */
  action: z.enum(['buy', 'sell']),
  /** Token symbol (e.g. 'ETH', 'USDC'). */
  symbol: z.string().min(1),
  /** Token contract address. */
  address: z.string().min(1),
  /** Chain identifier matching CHAINS keys. */
  chain: z.string().min(1),
  /** USD amount to trade. */
  amount: z.string(),
  /** Expected entry price (USD). Optional. */
  entry_price: z.number().optional(),
  /** Expected amount out (token units). Optional — used for stub receipt. */
  expected_amount_out: z.number().optional(),
  /** Slippage tolerance in basis points. Optional. */
  slippage_bps: z.number().int().min(0).max(10000).optional(),
  /** Tier for position sizing rules. Optional. */
  tier: z.string().optional(),
  /** Stop loss price. Optional. */
  stop_loss: z.number().optional(),
});

export type OrderInput = z.infer<typeof OrderInputSchema>;

// ---------------------------------------------------------------------------
// ReceiptJson — what the executor writes to stdout (last JSON line)
// ---------------------------------------------------------------------------

/**
 * Zod schema for a successful receipt emitted by the executor binary.
 *
 * The executor guarantees exactly ONE JSON line on stdout (the receipt).
 * All other output (logs, preflight messages) goes to stderr.
 */
export const SuccessReceiptSchema = z.object({
  status: z.literal('executed'),
  /** On-chain transaction hash (real: Safe/Squads hash; stub: sha256-derived). */
  tx_hash: z.string().min(1),
  /** Block number (stub: 1000000). */
  block_number: z.number().int().min(0),
  /** Gas used as a string (EVM) or lamports (Solana), or 0 for stub. */
  gas_used: z.union([z.string(), z.number()]),
  /** Actual amount sent in (base units). */
  actual_amount_in: z.string(),
  /** Actual amount received out (base units). */
  actual_amount_out: z.number(),
  /** Realized slippage in basis points. */
  slippage_bps: z.number().int().min(0),
  /** ISO-8601 execution timestamp. */
  executed_at: z.string().datetime(),
});

/**
 * Zod schema for a failure receipt emitted by the executor binary.
 *
 * On any error, the executor prints a failure JSON to stdout (not stderr)
 * and exits with code 1. This lets the worker parse the error kind.
 */
export const FailureReceiptSchema = z.object({
  status: z.literal('failed'),
  /** Human-readable error message. */
  error: z.string(),
  /** Machine-readable error kind for routing / alerting. */
  error_kind: z.string(),
});

/** Union of success and failure receipt shapes. */
export const ReceiptJsonSchema = z.discriminatedUnion('status', [SuccessReceiptSchema, FailureReceiptSchema]);

export type SuccessReceipt = z.infer<typeof SuccessReceiptSchema>;
export type FailureReceipt = z.infer<typeof FailureReceiptSchema>;
export type ReceiptJson = z.infer<typeof ReceiptJsonSchema>;

// ---------------------------------------------------------------------------
// ExecutorResult — return value of spawnExecutor()
// ---------------------------------------------------------------------------

/** Result returned by spawnExecutor() after the child process exits. */
export interface ExecutorResult {
  /** Child process exit code. */
  exitCode: number | null;
  /** Parsed receipt from stdout. Null if stdout was unparseable. */
  receipt: ReceiptJson | null;
  /** Raw stderr output (executor logs + preflight messages). */
  stderr: string;
  /** Wall-clock latency in milliseconds. */
  latencyMs: number;
}
