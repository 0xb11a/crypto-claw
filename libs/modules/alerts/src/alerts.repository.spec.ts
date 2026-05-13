/**
 * Unit tests for AlertsRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AlertsRepository } from './alerts.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawAlert = {
  id: 'alert-1',
  symbol: 'ETH',
  chain: 'base',
  alertType: 'stop_loss',
  severity: 'high',
  currentPrice: 1500.0,
  triggerPrice: 1600.0,
  details: 'Price below stop loss',
  action: 'sell',
  sellAmount: '100%',
  processed: 0,
  processedAt: null,
  createdAt: '2026-01-01T00:00:00Z',
};

function makePrisma(): PrismaService {
  return {
    sentinelAlert: {
      findMany: vi.fn().mockResolvedValue([rawAlert]),
      findUnique: vi.fn().mockResolvedValue(rawAlert),
      create: vi.fn().mockResolvedValue(rawAlert),
      update: vi.fn().mockResolvedValue({ ...rawAlert, processed: 1, processedAt: '2026-01-01T01:00:00Z' }),
      count: vi.fn().mockResolvedValue(1),
    },
  } as unknown as PrismaService;
}

describe('AlertsRepository', () => {
  let repo: AlertsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AlertsRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns mapped alerts with snake_case fields', async () => {
      const alerts = await repo.findMany({});
      expect(alerts).toHaveLength(1);
      const a = alerts[0]!;
      expect(a.id).toBe('alert-1');
      expect(a.alert_type).toBe('stop_loss');
      expect(a.current_price).toBe(1500.0);
      expect(a.processed).toBe(0);
    });

    it('passes unprocessed filter to Prisma', async () => {
      await repo.findMany({ unprocessed: true });
      expect(prisma.sentinelAlert.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ processed: 0 }) }),
      );
    });

    it('passes chain filter to Prisma', async () => {
      await repo.findMany({ chain: 'solana' });
      expect(prisma.sentinelAlert.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ chain: 'solana' }) }),
      );
    });
  });

  describe('findById()', () => {
    it('returns mapped alert', async () => {
      const result = await repo.findById('alert-1');
      expect(result.id).toBe('alert-1');
    });

    it('throws NotFoundException for missing alert', async () => {
      (prisma.sentinelAlert.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('acknowledge()', () => {
    it('sets processed=1 and processedAt on first ack', async () => {
      const result = await repo.acknowledge('alert-1');
      expect(prisma.sentinelAlert.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'alert-1' }, data: expect.objectContaining({ processed: 1 }) }),
      );
      expect(result.processed).toBe(1);
      expect(result.processed_at).toBeTruthy();
    });

    it('is idempotent — re-ack returns existing row without update', async () => {
      // Simulate already-processed alert
      const alreadyProcessed = { ...rawAlert, processed: 1, processedAt: '2026-01-01T00:30:00Z' };
      (prisma.sentinelAlert.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(alreadyProcessed);
      const result = await repo.acknowledge('alert-1');
      // Should NOT call update on re-ack
      expect(prisma.sentinelAlert.update).not.toHaveBeenCalled();
      expect(result.processed).toBe(1);
      // processedAt should be the ORIGINAL timestamp, not overwritten
      expect(result.processed_at).toBe('2026-01-01T00:30:00Z');
    });

    it('throws NotFoundException for missing alert', async () => {
      (prisma.sentinelAlert.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      await expect(repo.acknowledge('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('count()', () => {
    it('counts alerts', async () => {
      const count = await repo.count({});
      expect(count).toBe(1);
      expect(prisma.sentinelAlert.count).toHaveBeenCalled();
    });

    it('passes unprocessed filter to count', async () => {
      await repo.count({ unprocessed: true });
      expect(prisma.sentinelAlert.count).toHaveBeenCalledWith(
        expect.objectContaining({ where: expect.objectContaining({ processed: 0 }) }),
      );
    });
  });
});
