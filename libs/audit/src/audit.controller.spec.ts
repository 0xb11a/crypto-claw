/**
 * Unit tests for AuditController (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AuditController } from './audit.controller.js';
import type { AuditRepository } from './audit.repository.js';
import type { ServiceAuditEntryDto } from './dto/audit-response.dto.js';

const entry: ServiceAuditEntryDto = {
  id: 'cuid-1',
  ts: '2026-01-01T00:00:00Z',
  identity: 'RESEARCH',
  role: 'agent',
  method: 'POST',
  path: '/v1/orders',
  body_sha256: 'abc123',
  status: 201,
  latency_ms: 50,
};

function makeRepo(overrides?: Partial<AuditRepository>): AuditRepository {
  return {
    findMany: vi.fn().mockResolvedValue([entry]),
    count: vi.fn().mockResolvedValue(1),
    findById: vi.fn().mockResolvedValue(entry),
    create: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as AuditRepository;
}

describe('AuditController', () => {
  let ctrl: AuditController;
  let repo: AuditRepository;

  beforeEach(() => {
    repo = makeRepo();
    ctrl = new AuditController(repo);
  });

  describe('list()', () => {
    it('returns paginated audit entries', async () => {
      const result = await ctrl.list({});
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.cursor).toBe('cuid-1');
      expect(result.pagination.hasMore).toBe(false);
    });

    it('passes identity filter to repository', async () => {
      await ctrl.list({ identity: 'RESEARCH' });
      expect(repo.findMany).toHaveBeenCalledWith(expect.objectContaining({ identity: 'RESEARCH' }));
    });

    it('hasMore=true when data.length === limit', async () => {
      const entries = Array.from({ length: 100 }, (_, i) => ({ ...entry, id: `c-${i}` }));
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue(entries), count: vi.fn().mockResolvedValue(200) });
      const c = new AuditController(r);
      const result = await c.list({ limit: 100 });
      expect(result.pagination.hasMore).toBe(true);
    });

    it('limits to 1000 max', async () => {
      await ctrl.list({ limit: 9999 });
      // The limit in pagination should be capped at 1000
      const entries = Array.from({ length: 1 }, (_, i) => ({ ...entry, id: `c-${i}` }));
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue(entries), count: vi.fn().mockResolvedValue(1) });
      const c = new AuditController(r);
      const result = await c.list({ limit: 9999 });
      expect(result.pagination.limit).toBe(1000);
    });
  });

  describe('getById()', () => {
    it('returns audit entry by ID', async () => {
      const result = await ctrl.getById('cuid-1');
      expect(repo.findById).toHaveBeenCalledWith('cuid-1');
      expect(result).toBe(entry);
    });

    it('propagates NotFoundException', async () => {
      const r = makeRepo({ findById: vi.fn().mockRejectedValue(new NotFoundException('not found')) });
      const c = new AuditController(r);
      await expect(c.getById('x')).rejects.toThrow(NotFoundException);
    });
  });
});
