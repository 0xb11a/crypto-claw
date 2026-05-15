/**
 * Unit tests for position-reconcile queue-names constants (DoD §A, §E).
 *
 * Mirrors governance/queue-names.spec.ts pattern.
 */

import { describe, it, expect } from 'vitest';
import { POSITION_RECONCILE_QUEUE, POSITION_RECONCILE_JOB_OPTIONS } from './queue-names.js';

describe('POSITION_RECONCILE_QUEUE constant', () => {
  it('equals "position-reconcile"', () => {
    expect(POSITION_RECONCILE_QUEUE).toBe('position-reconcile');
  });
});

describe('POSITION_RECONCILE_JOB_OPTIONS retry policy (DoD §E)', () => {
  it('has attempts: 2', () => {
    expect(POSITION_RECONCILE_JOB_OPTIONS.attempts).toBe(2);
  });

  it('has backoff type "fixed"', () => {
    expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.type).toBe('fixed');
  });

  it('has backoff delay of 60_000 ms (60 s)', () => {
    expect(POSITION_RECONCILE_JOB_OPTIONS.backoff.delay).toBe(60_000);
  });

  it('retains last 50 completed jobs', () => {
    expect(POSITION_RECONCILE_JOB_OPTIONS.removeOnComplete).toBe(50);
  });

  it('retains last 20 failed jobs', () => {
    expect(POSITION_RECONCILE_JOB_OPTIONS.removeOnFail).toBe(20);
  });
});
