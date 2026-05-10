import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHash } from 'node:crypto';
import { AuditService } from './audit.service.js';
import { canonicalJson } from './canonical-json.js';
import type { AuditRepository } from './audit.repository.js';

const makeRepo = (): AuditRepository =>
  ({
    create: vi.fn().mockResolvedValue(undefined),
  }) as unknown as AuditRepository;

describe('AuditService', () => {
  let svc: AuditService;
  let repo: AuditRepository;

  beforeEach(() => {
    repo = makeRepo();
    svc = new AuditService(repo);
  });

  it('computes correct sha256 for a simple body', async () => {
    const body = { symbol: 'ETH', action: 'buy' };
    const expectedHash = createHash('sha256').update(canonicalJson(body), 'utf8').digest('hex');

    await svc.write({
      ts: '2026-01-01T00:00:00Z',
      identity: 'RESEARCH',
      role: 'agent',
      method: 'POST',
      path: '/v1/orders',
      body,
      status: 201,
      latencyMs: 42,
    });

    const call = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { bodySha256: string };
    expect(call.bodySha256).toBe(expectedHash);
  });

  it('sha256 is order-independent (canonical key sort)', async () => {
    const body1 = { b: 2, a: 1 };
    const body2 = { a: 1, b: 2 };

    const writeInput = (body: unknown) =>
      svc.write({
        ts: '2026-01-01T00:00:00Z',
        identity: 'RESEARCH',
        role: 'agent',
        method: 'POST',
        path: '/v1/orders',
        body,
        status: 201,
        latencyMs: 1,
      });

    await writeInput(body1);
    await writeInput(body2);

    const calls = (repo.create as ReturnType<typeof vi.fn>).mock.calls as Array<[{ bodySha256: string }]>;
    expect(calls[0][0].bodySha256).toBe(calls[1][0].bodySha256);
  });

  it('redacts a known secret pattern from body_redacted', async () => {
    const body = { token: 'sk-abc123456789012345678901234567890' }; // pre-commit-allow

    await svc.write({
      ts: '2026-01-01T00:00:00Z',
      identity: 'RESEARCH',
      role: 'agent',
      method: 'POST',
      path: '/v1/orders',
      body,
      status: 201,
      latencyMs: 1,
    });

    const call = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { bodyRedacted: string };
    expect(call.bodyRedacted).not.toContain('sk-abc123456789012345678901234567890'); // pre-commit-allow
    expect(call.bodyRedacted).toContain('[REDACTED]');
  });

  it('sets body_redacted to undefined when body is null', async () => {
    await svc.write({
      ts: '2026-01-01T00:00:00Z',
      identity: 'RESEARCH',
      role: 'agent',
      method: 'POST',
      path: '/v1/orders',
      body: null,
      status: 201,
      latencyMs: 1,
    });

    const call = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as { bodyRedacted: unknown };
    expect(call.bodyRedacted).toBeUndefined();
  });
});
