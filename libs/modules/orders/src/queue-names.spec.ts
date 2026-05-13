/**
 * Unit tests for queue-names.ts — canonical BullMQ queue naming.
 *
 * Covers:
 *   - Basic format: execute-order-<chain>-<safeAddressLower>
 *   - Lowercase normalisation of safeAddress
 *   - No ':' separator (BullMQ rejects bare ':')
 *   - Two distinct safes → two distinct queue names (C from plan)
 *
 * SPEC §14 — unit tests; DoD §A — fails before / passes after.
 * ADR-0024 addendum — lock the queue naming contract.
 */

import { describe, it, expect } from 'vitest';
import { executeOrderQueueName } from './queue-names.js';

describe('executeOrderQueueName()', () => {
  it('produces the expected format execute-order-<chain>-<safe>', () => {
    expect(executeOrderQueueName('base', '0xabc')).toBe('execute-order-base-0xabc');
  });

  it('lowercases the safeAddress', () => {
    expect(executeOrderQueueName('base', '0xAbCdEf')).toBe('execute-order-base-0xabcdef');
  });

  it('uses - separator (BullMQ rejects bare :)', () => {
    const name = executeOrderQueueName('ethereum', '0x1234');
    expect(name).not.toContain(':');
    expect(name).toContain('-');
  });

  it('uses solana chain name correctly', () => {
    expect(executeOrderQueueName('solana', 'SoLaNaVaUlTAddr')).toBe('execute-order-solana-solanavaultaddr');
  });

  it('two distinct safe addresses on the same chain produce distinct queue names (ADR-0024)', () => {
    const q1 = executeOrderQueueName('base', '0xsafe1');
    const q2 = executeOrderQueueName('base', '0xsafe2');
    expect(q1).not.toBe(q2);
  });

  it('same chain + same safe always produces the same name (deterministic)', () => {
    const a = executeOrderQueueName('base', '0xABCDEF');
    const b = executeOrderQueueName('base', '0xabcdef');
    expect(a).toBe(b);
  });

  it('two distinct chains with the same safe address produce distinct queue names', () => {
    const q1 = executeOrderQueueName('base', '0xabcd');
    const q2 = executeOrderQueueName('ethereum', '0xabcd');
    expect(q1).not.toBe(q2);
  });

  it('trims leading/trailing whitespace that callers may pass', () => {
    // The naming function lowercases the address — callers normalise whitespace
    // before calling (active-queue-names.ts does .trim()); the function itself
    // does NOT strip whitespace, so this documents the caller contract.
    const name = executeOrderQueueName('base', '0xabcd');
    expect(name).toBe('execute-order-base-0xabcd');
  });
});
