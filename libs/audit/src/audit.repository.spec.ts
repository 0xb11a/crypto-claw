/**
 * Unit tests for AuditRepository (SPEC §9.5, ADR-0018).
 *
 * Verifies that create() correctly delegates to prismaService.serviceAudit.create
 * with all required fields populated. Also covers read methods (P1b).
 *
 * DoD §A — every code change has a test.
 * DoD §D — repository updated with tests covering the new shape.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuditRepository } from './audit.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawEntry = {
  id: 'cuid-1',
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
};

function makePrisma(): PrismaService {
  return {
    serviceAudit: {
      create: vi.fn().mockResolvedValue(undefined),
      findMany: vi.fn().mockResolvedValue([rawEntry]),
      findUnique: vi.fn().mockResolvedValue(rawEntry),
      count: vi.fn().mockResolvedValue(1),
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

  // ---------------------------------------------------------------------------
  // create()
  // ---------------------------------------------------------------------------

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

  // ---------------------------------------------------------------------------
  // findMany()
  // ---------------------------------------------------------------------------

  describe('findMany()', () => {
    it('returns mapped entries with snake_case fields', async () => {
      const result = await repo.findMany({});
      expect(result).toHaveLength(1);
      const e = result[0]!;
      expect(e.id).toBe('cuid-1');
      expect(e.body_sha256).toBe('abc123');
      expect(e.latency_ms).toBe(42);
    });

    it('passes identity filter to Prisma', async () => {
      await repo.findMany({ identity: 'RESEARCH' });
      expect(prisma.serviceAudit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ identity: 'RESEARCH' }) }),
      );
    });

    it('applies cursor filter when cursor is provided', async () => {
      await repo.findMany({ cursor: 'prev-id' });
      expect(prisma.serviceAudit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ id: { lt: 'prev-id' } }) }),
      );
    });

    it('orders by ts desc then id desc', async () => {
      await repo.findMany({});
      expect(prisma.serviceAudit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ ts: 'desc' }, { id: 'desc' }] }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // count()
  // ---------------------------------------------------------------------------

  describe('count()', () => {
    it('counts entries', async () => {
      const result = await repo.count({});
      expect(result).toBe(1);
    });

    it('passes role filter', async () => {
      await repo.count({ role: 'agent' });
      expect(prisma.serviceAudit.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ role: 'agent' }) }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // findById()
  // ---------------------------------------------------------------------------

  describe('findById()', () => {
    it('returns entry by ID', async () => {
      const result = await repo.findById('cuid-1');
      expect(result.id).toBe('cuid-1');
    });

    it('throws NotFoundException for missing entry', async () => {
      (prisma.serviceAudit.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });
});
