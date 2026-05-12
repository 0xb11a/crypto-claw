/**
 * Unit tests for apps/executor/src/order-input.ts
 *
 * readOrderFromStdin() accepts an optional Readable parameter so tests can
 * inject a stream shim instead of touching process.stdin.
 */
import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readOrderFromStdin } from './order-input.js';

/** Build a Readable that emits `content` and immediately ends. */
function makeStream(content: string): Readable {
  return Readable.from([content]);
}

/** Minimal valid order matching OrderInputSchema. */
const VALID_ORDER = {
  id: 'test-order-00000001',
  action: 'buy' as const,
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '100.00',
  expected_amount_out: 0.05,
  slippage_bps: 200,
  tier: 'conviction',
};

describe('readOrderFromStdin()', () => {
  // -------------------------------------------------------------------------
  // Happy path
  // -------------------------------------------------------------------------

  it('parses a valid order JSON and returns typed OrderInput', async () => {
    const stream = makeStream(JSON.stringify(VALID_ORDER));
    const result = await readOrderFromStdin(stream);
    expect(result.id).toBe(VALID_ORDER.id);
    expect(result.action).toBe('buy');
    expect(result.chain).toBe('base');
    expect(result.amount).toBe('100.00');
  });

  it('strips leading/trailing whitespace before parsing', async () => {
    const stream = makeStream('   ' + JSON.stringify(VALID_ORDER) + '\n');
    const result = await readOrderFromStdin(stream);
    expect(result.id).toBe(VALID_ORDER.id);
  });

  it('handles a sell order', async () => {
    const sellOrder = { ...VALID_ORDER, action: 'sell' as const };
    const stream = makeStream(JSON.stringify(sellOrder));
    const result = await readOrderFromStdin(stream);
    expect(result.action).toBe('sell');
  });

  it('accepts an order without optional fields (slippage_bps, tier, entry_price)', async () => {
    const minimal = {
      id: 'min-order-001',
      action: 'buy' as const,
      symbol: 'USDC',
      address: '0x0000000000000000000000000000000000000002',
      chain: 'base',
      amount: '50.00',
    };
    const stream = makeStream(JSON.stringify(minimal));
    const result = await readOrderFromStdin(stream);
    expect(result.id).toBe('min-order-001');
    expect(result.slippage_bps).toBeUndefined();
    expect(result.tier).toBeUndefined();
  });

  it('returns data that matches the exact OrderInput shape', async () => {
    const order = {
      ...VALID_ORDER,
      entry_price: 3000,
      stop_loss: 2500,
    };
    const stream = makeStream(JSON.stringify(order));
    const result = await readOrderFromStdin(stream);
    expect(result.entry_price).toBe(3000);
    expect(result.stop_loss).toBe(2500);
  });

  // -------------------------------------------------------------------------
  // Empty stdin
  // -------------------------------------------------------------------------

  it('throws with "stdin was empty" message when stream is empty', async () => {
    const stream = makeStream('');
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin was empty — expected order JSON');
  });

  it('throws with "stdin was empty" for whitespace-only input', async () => {
    const stream = makeStream('   \n  \t  ');
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin was empty — expected order JSON');
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  it('throws with "not valid JSON" when input is malformed JSON', async () => {
    const stream = makeStream('{bad json}');
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin is not valid JSON');
  });

  it('throws with "not valid JSON" for a bare string', async () => {
    const stream = makeStream('just-a-string');
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin is not valid JSON');
  });

  it('throws with "not valid JSON" for truncated JSON', async () => {
    const stream = makeStream('{"id": "x",');
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin is not valid JSON');
  });

  // -------------------------------------------------------------------------
  // Zod schema validation failures
  // -------------------------------------------------------------------------

  it('throws with "order validation failed" when required field id is missing', async () => {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { id: _id, ...withoutId } = VALID_ORDER;
    const stream = makeStream(JSON.stringify(withoutId));
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] order validation failed');
  });

  it('throws with "order validation failed" when action is invalid enum value', async () => {
    const bad = { ...VALID_ORDER, action: 'hold' };
    const stream = makeStream(JSON.stringify(bad));
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] order validation failed');
  });

  it('throws with "order validation failed" when id is empty string', async () => {
    const bad = { ...VALID_ORDER, id: '' };
    const stream = makeStream(JSON.stringify(bad));
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] order validation failed');
  });

  it('throws with "order validation failed" for JSON array (wrong shape)', async () => {
    const stream = makeStream(JSON.stringify([VALID_ORDER]));
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] order validation failed');
  });

  it('throws with "order validation failed" when slippage_bps exceeds max 10000', async () => {
    const bad = { ...VALID_ORDER, slippage_bps: 10001 };
    const stream = makeStream(JSON.stringify(bad));
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] order validation failed');
  });

  // -------------------------------------------------------------------------
  // Stream error event
  // -------------------------------------------------------------------------

  it('throws with "stdin read error" when stream emits an error event', async () => {
    const stream = new Readable({
      read() {
        // Push nothing; emit error immediately.
        this.destroy(new Error('simulated read failure'));
      },
    });
    await expect(readOrderFromStdin(stream)).rejects.toThrow('[order-input] stdin read error');
  });
});
