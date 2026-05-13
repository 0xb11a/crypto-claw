/**
 * order-input.ts — Reads order JSON from a Readable stream (default: stdin).
 *
 * The worker writes a single JSON line to the executor's stdin before
 * closing it. This module reads the stream to end, parses the content as
 * JSON, and validates it against OrderInputSchema.
 *
 * The `stream` parameter defaults to `process.stdin` so the CLI entry point
 * (`main.ts`) calls `readOrderFromStdin()` with no arguments. Tests inject a
 * `Readable.from([...])` shim so the function can be exercised in-process
 * without spawning a subprocess.
 *
 * @see libs/execution/src/types.ts — shared OrderInputSchema
 */
import { Readable } from 'node:stream';
import { OrderInputSchema, type OrderInput } from '@cclaw/execution';

/**
 * Read and validate the order from a Readable stream.
 *
 * @param stream - Readable to consume (defaults to `process.stdin`).
 * @returns Validated OrderInput object.
 * @throws {Error} if the stream is empty, not valid JSON, or fails Zod validation.
 */
export async function readOrderFromStdin(stream: Readable = process.stdin): Promise<OrderInput> {
  return new Promise((resolve, reject) => {
    let raw = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk: string) => {
      raw += chunk;
    });

    stream.on('end', () => {
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

    stream.on('error', (err) => {
      reject(new Error(`[order-input] stdin read error: ${String(err)}`));
    });
  });
}
