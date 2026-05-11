/**
 * receipt-parser.ts — Parses executor stdout into a ReceiptJson.
 *
 * Protocol contract:
 *   - The executor MUST print exactly one JSON line to stdout (the receipt).
 *   - All other output (logs, preflight messages) MUST go to stderr.
 *   - This parser extracts the LAST line from stdout that parses as valid JSON,
 *     then validates it against ReceiptJsonSchema.
 *
 * Using the LAST line is intentional: it survives any stray stdout noise that
 * an executor shim might emit before the final receipt.
 */
import { ReceiptJsonSchema, type ReceiptJson } from './types.js';

/**
 * Parse executor stdout into a ReceiptJson.
 *
 * @param stdout - Raw stdout string from the executor child process.
 * @returns Validated ReceiptJson, or null if parsing/validation fails.
 */
export function parseExecutorReceipt(stdout: string): ReceiptJson | null {
  if (!stdout || stdout.trim().length === 0) return null;

  // Find the LAST non-empty line
  const lines = stdout.split('\n').filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;

  const lastLine = lines[lines.length - 1]!.trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(lastLine);
  } catch {
    return null;
  }

  const result = ReceiptJsonSchema.safeParse(parsed);
  if (!result.success) {
    return null;
  }

  return result.data;
}
