/**
 * Unit tests for HeartbeatRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { HeartbeatRepository } from './heartbeat.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawRow = {
  agent: 'executor',
  checkType: 'process_orders',
  lastRun: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  return {
    heartbeatState: {
      findMany: vi.fn().mockResolvedValue([rawRow]),
      upsert: vi.fn().mockResolvedValue(rawRow),
    },
  } as unknown as PrismaService;
}

describe('HeartbeatRepository', () => {
  let repo: HeartbeatRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new HeartbeatRepository(prisma);
  });

  describe('findAll()', () => {
    it('returns all rows when no agent specified', async () => {
      const rows = await repo.findAll();
      expect(rows).toHaveLength(1);
      expect(rows[0]!.agent).toBe('executor');
      expect(rows[0]!.checkType).toBe('process_orders');
      expect(rows[0]!.lastRun).toBe('2026-01-01T00:00:00Z');
    });

    it('passes agent filter to Prisma', async () => {
      await repo.findAll('executor');
      expect(prisma.heartbeatState.findMany).toHaveBeenCalledWith({ where: { agent: 'executor' } });
    });

    it('passes no where clause when agent is undefined', async () => {
      await repo.findAll(undefined);
      expect(prisma.heartbeatState.findMany).toHaveBeenCalledWith({ where: undefined });
    });
  });

  describe('findByAgent()', () => {
    it('returns rows for agent', async () => {
      const rows = await repo.findByAgent('executor');
      expect(rows[0]!.agent).toBe('executor');
    });

    it('throws NotFoundException when no rows found', async () => {
      (prisma.heartbeatState.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
      await expect(repo.findByAgent('unknown')).rejects.toThrow(NotFoundException);
    });
  });

  describe('ping()', () => {
    it('upserts with current timestamp and returns row', async () => {
      const result = await repo.ping('executor', 'process_orders');
      expect(prisma.heartbeatState.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { agent_checkType: { agent: 'executor', checkType: 'process_orders' } },
          update: expect.objectContaining({ lastRun: expect.any(String) }),
          create: expect.objectContaining({ agent: 'executor', checkType: 'process_orders' }),
        }),
      );
      expect(result.agent).toBe('executor');
    });
  });
});
