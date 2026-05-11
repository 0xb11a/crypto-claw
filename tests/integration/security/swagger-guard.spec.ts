/**
 * Swagger UI auth guard integration tests (SPEC §11, ADR-0022).
 *
 * Verifies that /v1/docs and /v1/openapi.json are behind agent-role auth.
 *
 * The enforce path was taken in P1b — a Fastify onRequest hook gates the routes.
 *
 * Gated by CCLAW_SECURITY_TESTS_ENABLED=1 (requires a running API).
 *
 * DoD §F — security: Swagger UI guard integration.
 */

import { describe, it, expect } from 'vitest';

const ENABLED = process.env['CCLAW_SECURITY_TESTS_ENABLED'] === '1';
const API_BASE = process.env['CCLAW_API_BASE'] ?? 'http://127.0.0.1:7878';
const AGENT_TOKEN = process.env['RESEARCH_API_KEY'] ?? '';
const DASHBOARD_TOKEN = process.env['DASHBOARD_API_KEY'] ?? '';

async function hit(path: string, token?: string): Promise<{ status: number }> {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  return { status: res.status };
}

describe.skipIf(!ENABLED)('Swagger UI guard (CCLAW_SECURITY_TESTS_ENABLED required)', () => {
  it('GET /v1/docs without bearer → 401', async () => {
    const { status } = await hit('/v1/docs');
    expect(status).toBe(401);
  });

  it('GET /v1/openapi.json without bearer → 401', async () => {
    const { status } = await hit('/v1/openapi.json');
    expect(status).toBe(401);
  });

  it('GET /v1/docs with unknown bearer → 401', async () => {
    const { status } = await hit('/v1/docs', 'unknown-token-that-does-not-exist');
    expect(status).toBe(401);
  });

  it('GET /v1/docs with dashboard role → 401 (agent role required)', async () => {
    const { status } = await hit('/v1/docs', DASHBOARD_TOKEN);
    expect(status).toBe(401);
  });

  it('GET /v1/docs with agent role bearer → 200 (HTML body)', async () => {
    const { status } = await hit('/v1/docs', AGENT_TOKEN);
    expect(status).toBe(200);
  });

  it('GET /v1/openapi.json with agent role bearer → 200 (JSON body)', async () => {
    const { status } = await hit('/v1/openapi.json', AGENT_TOKEN);
    expect(status).toBe(200);
  });
});
