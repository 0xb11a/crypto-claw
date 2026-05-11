/**
 * Throttler integration tests (SPEC §9.4, ADR-0021).
 *
 * These tests fire 600+ HTTP requests to trigger rate limiting. They are expensive
 * and should only run when explicitly opted in via CCLAW_SECURITY_TESTS_ENABLED=1.
 *
 * When CCLAW_SECURITY_TESTS_ENABLED is not set, all tests are skipped.
 *
 * Prerequisites: API must be running at CCLAW_API_BASE (default: http://127.0.0.1:7878).
 *
 * DoD §F — security: throttler guard integration.
 */

import { describe, it, expect } from 'vitest';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';
const API_BASE = process.env['CCLAW_API_BASE'] ?? 'http://127.0.0.1:7878';
const RESEARCH_TOKEN = process.env['RESEARCH_API_KEY'] ?? '';
const EXECUTOR_TOKEN = process.env['EXECUTOR_API_KEY'] ?? '';
const DASHBOARD_TOKEN = process.env['DASHBOARD_API_KEY'] ?? '';

async function hit(token: string, path = '/v1/receipts'): Promise<number> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}

describe.skipIf(!ENABLED)('Throttler integration (CCLAW_SECURITY_TESTS_ENABLED required)', () => {
  it('agent: 601st request within 60s returns 429', async () => {
    // Fire 600 requests from RESEARCH identity to fill the bucket
    for (let i = 0; i < 600; i++) {
      await hit(RESEARCH_TOKEN);
    }
    // 601st should be throttled
    const status = await hit(RESEARCH_TOKEN);
    expect(status).toBe(429);
  });

  it('dashboard: 61st request within 60s returns 429', async () => {
    for (let i = 0; i < 60; i++) {
      await hit(DASHBOARD_TOKEN);
    }
    const status = await hit(DASHBOARD_TOKEN);
    expect(status).toBe(429);
  });

  it('RESEARCH and EXECUTOR have independent buckets (700 mixed requests — neither trips)', async () => {
    // 400 from RESEARCH + 300 from EXECUTOR — both below their 600/min limit
    const requests: Promise<number>[] = [];
    for (let i = 0; i < 400; i++) {
      requests.push(hit(RESEARCH_TOKEN));
    }
    for (let i = 0; i < 300; i++) {
      requests.push(hit(EXECUTOR_TOKEN));
    }
    const statuses = await Promise.all(requests);
    const throttled = statuses.filter((s) => s === 429);
    expect(throttled.length).toBe(0);
  });

  it('/healthz is never throttled (1000 requests)', async () => {
    const requests = Array.from({ length: 1000 }, () => hit(RESEARCH_TOKEN, '/healthz'));
    const statuses = await Promise.all(requests);
    const throttled = statuses.filter((s) => s === 429);
    expect(throttled.length).toBe(0);
  });
});
