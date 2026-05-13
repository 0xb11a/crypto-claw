/**
 * Unit tests for apps/executor/src/main.ts — runExecutor() bootstrap function.
 *
 * These tests call runExecutor() directly (in-process) so v8 coverage captures
 * every branch. The prior subprocess-based tests lived here before the refactor;
 * they contributed zero in-process coverage because they spawned a child process.
 *
 * The integration smoke (spawning the compiled binary) is now covered by the
 * signer-isolation.spec.ts integration suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Readable, Writable } from 'node:stream';
import { runExecutor, classifyError } from './main.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a Readable that emits a JSON string and ends immediately. */
function stdinFrom(obj: unknown): Readable {
  return Readable.from([JSON.stringify(obj)]);
}

/** Build a Readable that emits a raw string (for error path tests). */
function stdinRaw(content: string): Readable {
  return Readable.from([content]);
}

/**
 * Capture-writable: collects everything written to it as a string.
 * Used to assert on stdout / stderr output without touching real FDs.
 */
function makeCapture(): { stream: Writable; get: () => string } {
  let buf = '';
  const stream = new Writable({
    write(chunk: Buffer | string, _enc: string, cb: () => void) {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      cb();
    },
  });
  return { stream, get: () => buf };
}

/** Minimal valid env matching AppConfig (uses 16-char keys to pass CI schema). */
const VALID_ENV: NodeJS.ProcessEnv = {
  SAFE_ID: 'ci-test',
  REDIS_URL: 'redis://localhost:6379',
  RESEARCH_API_KEY: 'aaaaaaaaaaaaaaaa',
  SENTINEL_API_KEY: 'bbbbbbbbbbbbbbbb',
  EXECUTOR_API_KEY: 'cccccccccccccccc',
  OBSERVER_API_KEY: 'dddddddddddddddd',
  LOOP_API_KEY: 'eeeeeeeeeeeeeeee',
  WORKER_API_KEY: 'ffffffffffffffff',
  SCHEDULER_API_KEY: 'gggggggggggggggg',
  DASHBOARD_API_KEY: 'hhhhhhhhhhhhhhhh',
  ACTIVE_CHAINS: 'base,solana',
  OPENAI_API_KEY: 'ci-dummy',
  EXECUTOR_STUB_MODE: '1',
  SAFE_SIGNER_KEY: 'ci-stub-signer-key-for-executor',
};

/** Minimal valid order matching OrderInputSchema. */
const VALID_ORDER = {
  id: 'test-order-main-001',
  action: 'buy' as const,
  symbol: 'ETH',
  address: '0x0000000000000000000000000000000000000001',
  chain: 'base',
  amount: '100.00',
  expected_amount_out: 0.05,
  slippage_bps: 200,
  tier: 'conviction',
};

// ---------------------------------------------------------------------------
// classifyError() — pure function, no I/O
// ---------------------------------------------------------------------------

describe('classifyError()', () => {
  it('classifies signer_balance_insufficient', () => {
    expect(classifyError('signer_balance_insufficient: not enough ETH')).toBe('signer_balance_insufficient');
  });

  it('classifies slippage_exceeded', () => {
    expect(classifyError('slippage_exceeded: 300bps exceeds max 200bps')).toBe('slippage_exceeded');
  });

  it('classifies stale_price', () => {
    expect(classifyError('stale_price: drift is 15%')).toBe('stale_price');
  });

  it('classifies missing_signer_key when message contains SIGNER_KEY', () => {
    expect(classifyError('SAFE_SIGNER_KEY is required but not set')).toBe('missing_signer_key');
  });

  it('classifies not_yet_implemented_real_mode', () => {
    expect(classifyError('not_yet_implemented_real_mode')).toBe('not_yet_implemented_real_mode');
  });

  it('classifies order_validation_failed', () => {
    expect(classifyError('[order-input] order validation failed: id — Required')).toBe('order_validation_failed');
  });

  it('falls back to executor_error for unrecognized messages', () => {
    expect(classifyError('some unexpected runtime exception')).toBe('executor_error');
  });

  // P1c-ii new error kinds
  it('classifies rpc_hostname_not_allowlisted', () => {
    expect(classifyError('rpc_hostname_not_allowlisted: evil.rpc.example on base')).toBe(
      'rpc_hostname_not_allowlisted',
    );
  });

  it('classifies safe_propose_failed when message contains safe_propose_failed', () => {
    expect(classifyError('safe_propose_failed: Safe TX Service returned 422')).toBe('safe_propose_failed');
  });

  it('classifies safe_propose_failed when message contains proposeTransaction', () => {
    expect(classifyError('proposeTransaction: HTTP 422 [invalid nonce]')).toBe('safe_propose_failed');
  });

  it('classifies oneinch_failed', () => {
    expect(classifyError('oneinch_failed: 1inch API error (500): Internal Server Error')).toBe('oneinch_failed');
  });

  it('classifies transaction_reverted on execution reverted', () => {
    expect(classifyError('execution reverted: gas limit exceeded')).toBe('transaction_reverted');
  });

  it('classifies transaction_reverted on transaction_reverted prefix', () => {
    expect(classifyError('transaction_reverted: SafeL2: 0x01')).toBe('transaction_reverted');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — happy path
// ---------------------------------------------------------------------------

describe('runExecutor() — happy path', () => {
  it('resolves and writes a receipt JSON line to stdout', async () => {
    const out = makeCapture();
    const err = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: out.stream,
      stderr: err.stream,
      env: VALID_ENV,
    });

    const receiptLine = out.get().trim();
    const receipt = JSON.parse(receiptLine) as Record<string, unknown>;
    expect(receipt['status']).toBe('executed');
    expect(typeof receipt['tx_hash']).toBe('string');
    expect(receipt['tx_hash'] as string).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('receipt tx_hash is deterministic for the same order id', async () => {
    const run = () => {
      const out = makeCapture();
      return runExecutor({
        stdin: stdinFrom(VALID_ORDER),
        stdout: out.stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      }).then(() => JSON.parse(out.get().trim()) as Record<string, unknown>);
    };

    const [r1, r2] = await Promise.all([run(), run()]);
    expect(r1['tx_hash']).toBe(r2['tx_hash']);
  });

  it('writes EXECUTOR_STUB_MODE warning to stderr', async () => {
    const err = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: makeCapture().stream,
      stderr: err.stream,
      env: VALID_ENV,
    });

    expect(err.get()).toContain('EXECUTOR_STUB_MODE=true');
  });

  it('does NOT write stub warning to stderr when EXECUTOR_STUB_MODE is not 1', async () => {
    // Real-mode with missing config resolves with a failure receipt — no stub warning.
    const err = makeCapture();
    const env = { ...VALID_ENV, EXECUTOR_STUB_MODE: '0' };

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: makeCapture().stream,
      stderr: err.stream,
      env,
    });

    expect(err.get()).not.toContain('EXECUTOR_STUB_MODE=true');
  });

  it('receipt actual_amount_in matches order amount', async () => {
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env: VALID_ENV,
    });

    const receipt = JSON.parse(out.get().trim()) as Record<string, unknown>;
    expect(receipt['actual_amount_in']).toBe(VALID_ORDER.amount);
  });

  it('works for a solana order with SQUADS_SIGNER_KEY', async () => {
    const solanaOrder = { ...VALID_ORDER, id: 'sol-order-001', chain: 'solana' };
    const env = {
      ...VALID_ENV,
      SQUADS_SIGNER_KEY: 'ci-stub-squads-key-for-executor',
    };
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(solanaOrder),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env,
    });

    const receipt = JSON.parse(out.get().trim()) as Record<string, unknown>;
    expect(receipt['status']).toBe('executed');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — config validation failures
// ---------------------------------------------------------------------------

describe('runExecutor() — config validation failures', () => {
  it('throws when SAFE_ID is missing', async () => {
    const env = { ...VALID_ENV };
    delete env['SAFE_ID'];

    // assertConfigValid() calls process.exit(78) internally — we test that the
    // function throws (the exit is mocked at the process level in integration
    // tests; here we rely on the fact that vitest catches process.exit via the
    // thrown error signal or the test runner's exit intercept).
    //
    // In practice, assertConfigValid() calls process.exit(78) which throws in
    // the vitest environment because vitest overrides process.exit to throw
    // a special ExitError. We assert the promise rejects rather than asserting
    // on exit code (which is the integration test's job).
    await expect(
      runExecutor({
        stdin: stdinFrom(VALID_ORDER),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env,
      }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — missing signer keys
// ---------------------------------------------------------------------------

describe('runExecutor() — missing signer keys', () => {
  it('throws missing_signer_key when SAFE_SIGNER_KEY is absent for EVM order', async () => {
    const env = { ...VALID_ENV };
    delete env['SAFE_SIGNER_KEY'];

    await expect(
      runExecutor({
        stdin: stdinFrom(VALID_ORDER),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env,
      }),
    ).rejects.toThrow('SAFE_SIGNER_KEY');
  });

  it('throws missing_signer_key when SQUADS_SIGNER_KEY is absent for Solana order', async () => {
    const solanaOrder = { ...VALID_ORDER, chain: 'solana' };
    const env = { ...VALID_ENV }; // no SQUADS_SIGNER_KEY

    await expect(
      runExecutor({
        stdin: stdinFrom(solanaOrder),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env,
      }),
    ).rejects.toThrow('SQUADS_SIGNER_KEY');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — stub mode guard
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// NOTE (P1c-ii): The real EVM SDK path is now wired.
// When EXECUTOR_STUB_MODE is OFF for an EVM chain, executeTrade() dispatches to
// executeTradeEvm() which catches config/env errors and returns a FailureReceipt
// rather than throwing. runExecutor() resolves (writes failure receipt to stdout)
// and only throws if something unexpected happens upstream of executeTrade().
//
// The P1c-i tests below checked for the stub's "not_yet_implemented_real_mode" throw.
// P1c-ii updates them to check that missing-config is handled cleanly.
// ---------------------------------------------------------------------------

describe('runExecutor() — real mode (no stub)', () => {
  it('writes a failure receipt to stdout when EXECUTOR_STUB_MODE is "0" and config is missing', async () => {
    // VALID_ENV does NOT include SAFE_ADDRESS_BASE or RPC_BASE.
    // executeTradeEvm() catches the missing-config error and returns a FailureReceipt.
    const env = { ...VALID_ENV, EXECUTOR_STUB_MODE: '0' };
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env,
    });

    const receiptLine = out.get().trim();
    const receipt = JSON.parse(receiptLine) as Record<string, unknown>;
    // Expect a failure receipt (not a throw) — config error caught cleanly
    expect(receipt['status']).toBe('failed');
  });

  it('Solana real mode returns not_yet_implemented_real_mode receipt', async () => {
    const solanaOrder = { ...VALID_ORDER, id: 'sol-real-001', chain: 'solana' };
    const env = {
      ...VALID_ENV,
      EXECUTOR_STUB_MODE: '0',
      SQUADS_SIGNER_KEY: 'ci-squads-key-for-executor',
    };
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(solanaOrder),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env,
    });

    const receiptLine = out.get().trim();
    const receipt = JSON.parse(receiptLine) as Record<string, unknown>;
    expect(receipt['status']).toBe('failed');
    expect(receipt['error_kind']).toBe('not_yet_implemented_real_mode');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — order parsing failures
// ---------------------------------------------------------------------------

describe('runExecutor() — order parsing failures', () => {
  it('throws order_validation_failed when stdin is empty', async () => {
    await expect(
      runExecutor({
        stdin: stdinRaw(''),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      }),
    ).rejects.toThrow('[order-input] stdin was empty');
  });

  it('throws when stdin contains invalid JSON', async () => {
    await expect(
      runExecutor({
        stdin: stdinRaw('{not valid json'),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      }),
    ).rejects.toThrow('[order-input] stdin is not valid JSON');
  });

  it('throws order_validation_failed when order schema is invalid', async () => {
    const badOrder = { ...VALID_ORDER, action: 'hold' }; // invalid enum
    await expect(
      runExecutor({
        stdin: stdinFrom(badOrder),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      }),
    ).rejects.toThrow('[order-input] order validation failed');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — preflight failures
// ---------------------------------------------------------------------------

describe('runExecutor() — preflight slippage check', () => {
  it('throws slippage_exceeded when slippage_bps exceeds conviction limit', async () => {
    const overslippedOrder = { ...VALID_ORDER, slippage_bps: 300, tier: 'conviction' };

    await expect(
      runExecutor({
        stdin: stdinFrom(overslippedOrder),
        stdout: makeCapture().stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      }),
    ).rejects.toThrow('slippage_exceeded');
  });
});

// ---------------------------------------------------------------------------
// runExecutor() — stdout receipt is the last (and only) line
// ---------------------------------------------------------------------------

describe('runExecutor() — stdout is a single JSON line', () => {
  it('stdout contains exactly one non-empty line', async () => {
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env: VALID_ENV,
    });

    const lines = out
      .get()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(lines).toHaveLength(1);
  });

  it('stdout line parses as valid JSON', async () => {
    const out = makeCapture();

    await runExecutor({
      stdin: stdinFrom(VALID_ORDER),
      stdout: out.stream,
      stderr: makeCapture().stream,
      env: VALID_ENV,
    });

    const lines = out
      .get()
      .split('\n')
      .filter((l) => l.trim().length > 0);
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// beforeEach guard — ensure tests don't bleed into each other
// ---------------------------------------------------------------------------

// Defensive reset: vitest isolates module state between describe blocks
// but we document that no global state is mutated here.
describe('isolation sanity', () => {
  beforeEach(() => {
    // No shared mutable state in these tests — documented for future maintainers.
  });

  it('two sequential runExecutor calls produce independent receipts', async () => {
    const run = async (orderId: string) => {
      const out = makeCapture();
      const order = { ...VALID_ORDER, id: orderId };
      await runExecutor({
        stdin: stdinFrom(order),
        stdout: out.stream,
        stderr: makeCapture().stream,
        env: VALID_ENV,
      });
      return JSON.parse(out.get().trim()) as Record<string, unknown>;
    };

    const r1 = await run('order-seq-001');
    const r2 = await run('order-seq-002');

    expect(r1['tx_hash']).not.toBe(r2['tx_hash']);
    expect(r1['status']).toBe('executed');
    expect(r2['status']).toBe('executed');
  });
});
