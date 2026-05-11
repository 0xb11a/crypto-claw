/**
 * order-input.ts — Reads order JSON from stdin.
 *
 * The worker writes a single JSON line to the executor's stdin before
 * closing it. This module reads all of stdin, parses it as JSON, and
 * validates it against OrderInputSchema.
 *
 * @see libs/execution/src/types.ts — shared OrderInputSchema
 */
import { OrderInputSchema, type OrderInput } from '@cclaw/execution';

/**
 * Read and validate the order from stdin.
 *
 * @returns Validated OrderInput object.
 * @throws {Error} if stdin is empty, not valid JSON, or fails Zod validation.
 */
export async function readOrderFromStdin(): Promise<OrderInput> {
  return new Promise((resolve, reject) => {
    let raw = '';

    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk: string) => {
      raw += chunk;
    });

    process.stdin.on('end', () => {
      const trimmed = raw.trim();
      if (!trimmed) {
        reject(new Error('[order-input] stdin was empty — expected order JSON'));
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch (err) {
        reject(new Error(`[order-input] stdin is not valid JSON: ${String(err)}`));
        return;
      }

      const result = OrderInputSchema.safeParse(parsed);
      if (!result.success) {
        const first = result.error.issues[0];
        reject(
          new Error(
            `[order-input] order validation failed: ${first?.path.join('.') ?? '?'} — ${first?.message ?? 'unknown'}`,
          ),
        );
        return;
      }

      resolve(result.data);
    });

    process.stdin.on('error', (err) => {
      reject(new Error(`[order-input] stdin read error: ${String(err)}`));
    });
  });
}
