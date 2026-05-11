/**
 * Unit tests for IdlenessService (SPEC §14, DoD §A).
 *
 * Covers the cross-product required by the plan:
 *   (executor 0 pending / executor ≥1 pending) × (sentinel 0 open / sentinel ≥1 open) × (PAPER_MODE=true / false)
 */
import { describe, it, expect, vi } from 'vitest';
import { IdlenessService } from './idleness.service.js';
import type { PrismaService } from '@cclaw/prisma';
import type { ConfigService } from '@nestjs/config';
import type { AppConfig } from '@cclaw/config';

function makePrisma(overrides?: Partial<PrismaService>): PrismaService {
  return {
    order: {
      groupBy: vi.fn().mockResolvedValue([]),
    },
    position: {
      count: vi.fn().mockResolvedValue(0),
    },
    paperPosition: {
      count: vi.fn().mockResolvedValue(0),
    },
    ...overrides,
  } as unknown as PrismaService;
}

function makeConfig(paperMode = false): ConfigService {
  const cfg: Partial<AppConfig> = { PAPER_MODE: paperMode };
  return { get: vi.fn().mockReturnValue(cfg) } as unknown as ConfigService;
}

describe('IdlenessService', () => {
  let prisma: PrismaService;

  describe('checkExecutorWork()', () => {
    it('idle=true when no approved orders', async () => {
      prisma = makePrisma({ order: { groupBy: vi.fn().mockResolvedValue([]) } as unknown as PrismaService['order'] });
      const svc = new IdlenessService(prisma, makeConfig());
      const result = await svc.checkExecutorWork();
      expect(result.idle).toBe(true);
      expect(result.pendingBuys).toBe(0);
      expect(result.pendingSells).toBe(0);
    });

    it('idle=false when buy orders exist', async () => {
      prisma = makePrisma({
        order: {
          groupBy: vi.fn().mockResolvedValue([{ action: 'buy', _count: { action: 2 } }]),
        } as unknown as PrismaService['order'],
      });
      const svc = new IdlenessService(prisma, makeConfig());
      const result = await svc.checkExecutorWork();
      expect(result.idle).toBe(false);
      expect(result.pendingBuys).toBe(2);
      expect(result.pendingSells).toBe(0);
    });

    it('idle=false when sell orders exist', async () => {
      prisma = makePrisma({
        order: {
          groupBy: vi.fn().mockResolvedValue([{ action: 'sell', _count: { action: 1 } }]),
        } as unknown as PrismaService['order'],
      });
      const svc = new IdlenessService(prisma, makeConfig());
      const result = await svc.checkExecutorWork();
      expect(result.idle).toBe(false);
      expect(result.pendingSells).toBe(1);
    });
  });

  describe('checkSentinelWork()', () => {
    it('idle=true when no open positions (real mode)', async () => {
      prisma = makePrisma({
        position: { count: vi.fn().mockResolvedValue(0) } as unknown as PrismaService['position'],
      });
      const svc = new IdlenessService(prisma, makeConfig(false));
      const result = await svc.checkSentinelWork();
      expect(result.idle).toBe(true);
      expect(result.openPositions).toBe(0);
    });

    it('idle=false when open positions exist (real mode)', async () => {
      prisma = makePrisma({
        position: { count: vi.fn().mockResolvedValue(3) } as unknown as PrismaService['position'],
      });
      const svc = new IdlenessService(prisma, makeConfig(false));
      const result = await svc.checkSentinelWork();
      expect(result.idle).toBe(false);
      expect(result.openPositions).toBe(3);
    });

    it('queries paperPosition table in PAPER_MODE=true', async () => {
      prisma = makePrisma({
        paperPosition: { count: vi.fn().mockResolvedValue(2) } as unknown as PrismaService['paperPosition'],
        position: { count: vi.fn().mockResolvedValue(0) } as unknown as PrismaService['position'],
      });
      const svc = new IdlenessService(prisma, makeConfig(true));
      const result = await svc.checkSentinelWork();
      // Should query paperPosition (returns 2), not positions (returns 0)
      expect(result.openPositions).toBe(2);
      expect(result.idle).toBe(false);
      expect(prisma.paperPosition.count).toHaveBeenCalled();
      expect(prisma.position.count).not.toHaveBeenCalled();
    });

    it('PAPER_MODE=true with 0 paper positions → idle=true', async () => {
      prisma = makePrisma({
        paperPosition: { count: vi.fn().mockResolvedValue(0) } as unknown as PrismaService['paperPosition'],
      });
      const svc = new IdlenessService(prisma, makeConfig(true));
      const result = await svc.checkSentinelWork();
      expect(result.idle).toBe(true);
      expect(prisma.paperPosition.count).toHaveBeenCalled();
    });
  });
});
