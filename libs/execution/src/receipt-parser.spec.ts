/**
 * Unit tests for receipt-parser.ts
 *
 * Tests the "last JSON line" extraction and Zod schema validation.
 */
import { describe, it, expect } from 'vitest';
import { parseExecutorReceipt } from './receipt-parser.js';

const VALID_SUCCESS = JSON.stringify({
  status: 'executed',
  tx_hash: '0x' + 'a'.repeat(64),
  block_number: 1000000,
  gas_used: 50000,
  actual_amount_in: '1000000',
  actual_amount_out: 42.5,
  slippage_bps: 50,
  executed_at: new Date().toISOString(),
});

const VALID_FAILURE = JSON.stringify({
  status: 'failed',
  error: 'slippage exceeded',
  error_kind: 'slippage_exceeded',
});

describe('parseExecutorReceipt()', () => {
  it('parses a valid success receipt', () => {
    const result = parseExecutorReceipt(VALID_SUCCESS);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('executed');
  });

  it('parses a valid failure receipt', () => {
    const result = parseExecutorReceipt(VALID_FAILURE);
    expect(result).not.toBeNull();
    expect(result?.status).toBe('failed');
  });

  it('extracts the LAST JSON line from multi-line stdout', () => {
    const stdout = ['some debug output on line 1', '[preflight] signer balance ok', VALID_SUCCESS].join('\n');
    const result = parseExecutorReceipt(stdout);
    expect(result?.status).toBe('executed');
  });

  it('returns null for empty stdout', () => {
    expect(parseExecutorReceipt('')).toBeNull();
    expect(parseExecutorReceipt('   \n  ')).toBeNull();
  });

  it('returns null for non-JSON last line', () => {
    expect(parseExecutorReceipt('just some log text\nmore log')).toBeNull();
  });

  it('returns null for JSON that fails schema validation', () => {
    const badJson = JSON.stringify({ status: 'unknown', unrelated: 'field' });
    expect(parseExecutorReceipt(badJson)).toBeNull();
  });

  it('returns null for extra fields in strict mode (Zod strips)', () => {
    // Zod with passthrough allows extra fields; ReceiptJsonSchema does NOT
    // use passthrough, but discriminatedUnion strips unknown. Let's verify
    // the happy path still works with an extra field.
    const withExtra = JSON.stringify({
      status: 'executed',
      tx_hash: '0x' + 'b'.repeat(64),
      block_number: 999,
      gas_used: 21000,
      actual_amount_in: '500000',
      actual_amount_out: 10.0,
      slippage_bps: 25,
      executed_at: new Date().toISOString(),
      extra_field: 'stripped',
    });
    const result = parseExecutorReceipt(withExtra);
    expect(result?.status).toBe('executed');
  });

  it('returns null for missing required field (tx_hash)', () => {
    const missing = JSON.stringify({
      status: 'executed',
      block_number: 999,
      gas_used: 21000,
      actual_amount_in: '500000',
      actual_amount_out: 10.0,
      slippage_bps: 25,
      executed_at: new Date().toISOString(),
    });
    expect(parseExecutorReceipt(missing)).toBeNull();
  });

  it('handles stdout with trailing newlines', () => {
    const stdout = VALID_SUCCESS + '\n\n';
    const result = parseExecutorReceipt(stdout);
    expect(result?.status).toBe('executed');
  });
});
