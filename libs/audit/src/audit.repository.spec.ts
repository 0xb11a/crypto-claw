/**
 * Unit tests for AuditRepository (SPEC §9.5, ADR-0018).
 *
 * Verifies that create() correctly delegates to prismaService.serviceAudit.create
 * with all required fields populated.
 *
 * DoD §A — every code change has a test.
 * DoD §D — repository updated with tests covering the new shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuditRepository } from './audit.repository.js';
import type { PrismaService } from '@cclaw/prisma';

function makePrisma(): PrismaService {
  return {
    serviceAudit: {
      create: vi.fn().mockResolvedValue(undefined),
    },
  } as unknown as PrismaService;
}

describe('AuditRepository', () => {
  let repo: AuditRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AuditRepository(prisma);
  });

  it('calls prisma.serviceAudit.create with all required fields', async () => {
    const input = {
      ts: '2026-05-10T00:00:00Z',
      identity: 'RESEARCH',
      role: 'agent',
      method: 'POST',
      path: '/v1/orders',
      bodySha256: 'abc123',
      bodyRedacted: '{"action":"buy"}',
      status: 201,
      latencyMs: 42,
      errorKind: undefined,
    };

    await repo.create(input);

    expect(prisma.serviceAudit.create).toHaveBeenCalledWith({
      data: {
        ts: '2026-05-10T00:00:00Z',
        identity: 'RESEARCH',
        role: 'agent',
        method: 'POST',
        path: '/v1/orders',
        bodySha256: 'abc123',
        bodyRedacted: '{"action":"buy"}',
        status: 201,
        latencyMs: 42,
        errorKind: null,
      },
    });
  });

  it('uses null for optional fields when not provided', async () => {
    const input = {
      ts: '2026-05-10T00:00:00Z',
      identity: 'SENTINEL',
      role: 'agent',
      method: 'POST',
      path: '/v1/orders/order-1/approve',
      bodySha256: 'def456',
      status: 200,
      latencyMs: 10,
    };

    await repo.create(input);

    expect(prisma.serviceAudit.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          bodyRedacted: null,
          errorKind: null,
        }),
      }),
    );
  });

  it('propagates prisma errors to the caller', async () => {
    (prisma.serviceAudit.create as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('DB error'));
    await expect(
      repo.create({
        ts: '2026-05-10T00:00:00Z',
        identity: 'EXECUTOR',
        role: 'agent',
        method: 'POST',
        path: '/v1/orders',
        bodySha256: 'abc',
        status: 500,
        latencyMs: 5,
      }),
    ).rejects.toThrow('DB error');
  });
});
