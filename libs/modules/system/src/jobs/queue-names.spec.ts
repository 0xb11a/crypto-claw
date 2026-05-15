/**
 * Unit tests for portfolio-report queue-names constants (DoD §A, §E).
 */

import { describe, it, expect } from 'vitest';
import { PORTFOLIO_REPORT_QUEUE, PORTFOLIO_REPORT_JOB_OPTIONS } from './queue-names.js';

describe('PORTFOLIO_REPORT_QUEUE constant', () => {
  it('equals "portfolio-report"', () => {
    expect(PORTFOLIO_REPORT_QUEUE).toBe('portfolio-report');
  });
});

describe('PORTFOLIO_REPORT_JOB_OPTIONS retry policy (DoD §E)', () => {
  it('has attempts: 2', () => {
    expect(PORTFOLIO_REPORT_JOB_OPTIONS.attempts).toBe(2);
  });

  it('has backoff type "fixed"', () => {
    expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.type).toBe('fixed');
  });

  it('has backoff delay of 60_000 ms (60 s)', () => {
    expect(PORTFOLIO_REPORT_JOB_OPTIONS.backoff.delay).toBe(60_000);
  });

  it('retains last 50 completed jobs', () => {
    expect(PORTFOLIO_REPORT_JOB_OPTIONS.removeOnComplete).toBe(50);
  });

  it('retains last 20 failed jobs', () => {
    expect(PORTFOLIO_REPORT_JOB_OPTIONS.removeOnFail).toBe(20);
  });
});
