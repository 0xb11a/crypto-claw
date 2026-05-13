/**
 * Unit tests for WalletsRepository (SPEC §14, DoD §A).
 *
 * Uses a mocked PrismaService to verify the repository's mapping logic and
 * score_breakdown raw-string semantics.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WalletsRepository } from './wallets.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawRow = {
  address: '0xabc',
  chain: 'base',
  label: 'Test',
  type: 'smart_money',
  notes: null,
  status: 'scored',
  score: 82,
  scoreBreakdown: '{"birdeye":80}',
  sourceToken: null,
  scoredAt: '2026-01-01T00:00:00.000Z',
  scoreError: null,
  retryCount: 0,
  source: 'agent',
  lastCheckedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
};

function makePrisma(overrides?: Record<string, unknown>): PrismaService {
  return {
    trackedWallet: {
      findMany: vi.fn().mockResolvedValue([rawRow]),
      findUnique: vi.fn().mockResolvedValue(rawRow),
      upsert: vi.fn().mockResolvedValue(rawRow),
      update: vi.fn().mockResolvedValue(rawRow),
      delete: vi.fn().mockResolvedValue(rawRow),
    },
    $queryRaw: vi.fn().mockResolvedValue([rawRow]),
    ...overrides,
  } as unknown as PrismaService;
}

describe('WalletsRepository', () => {
  let repo: WalletsRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new WalletsRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns mapped rows with snake_case fields', async () => {
      const result = await repo.findMany({});
      expect(Array.isArray(result)).toBe(true);
      const r = result[0]!;
      expect(r.address).toBe('0xabc');
      expect(r.chain).toBe('base');
      expect(r.retry_count).toBe(0);
    });

    it('score_breakdown is returned as raw string (not parsed)', async () => {
      const result = await repo.findMany({});
      expect(typeof result[0]!.score_breakdown).toBe('string');
      expect(result[0]!.score_breakdown).toBe('{"birdeye":80}');
    });
  });

  describe('findOne()', () => {
    it('returns the mapped wallet', async () => {
      const result = await repo.findOne('0xabc', 'base');
      expect(result.address).toBe('0xabc');
    });

    it('throws NotFoundException when wallet is not found', async () => {
      const p = makePrisma({
        trackedWallet: {
          findUnique: vi.fn().mockResolvedValue(null),
        },
      });
      const r = new WalletsRepository(p);
      await expect(r.findOne('0xmissing', 'base')).rejects.toThrow(NotFoundException);
    });
  });

  describe('upsertWallet()', () => {
    it('returns the upserted wallet', async () => {
      const result = await repo.upsertWallet({ address: '0xabc', chain: 'base' });
      expect(result.address).toBe('0xabc');
    });

    it('serialises score_breakdown object to JSON string', async () => {
      await repo.upsertWallet({ address: '0xabc', chain: 'base', score_breakdown: { birdeye: 80 } });
      const upsertCall = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { scoreBreakdown: string };
      };
      expect(upsertCall.create.scoreBreakdown).toBe('{"birdeye":80}');
    });

    it('passes through string score_breakdown as-is', async () => {
      await repo.upsertWallet({ address: '0xabc', chain: 'base', score_breakdown: '{"birdeye":80}' });
      const upsertCall = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { scoreBreakdown: string };
      };
      expect(upsertCall.create.scoreBreakdown).toBe('{"birdeye":80}');
    });

    it('defaults status to proposed when type is absent', async () => {
      await repo.upsertWallet({ address: '0xabc', chain: 'base' });
      const call = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { status: string };
      };
      expect(call.create.status).toBe('proposed');
    });

    it('defaults status to scored when type is provided', async () => {
      await repo.upsertWallet({ address: '0xabc', chain: 'base', type: 'smart_money' });
      const call = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { status: string };
      };
      expect(call.create.status).toBe('scored');
    });
  });

  describe('proposeWallet()', () => {
    it('returns ok=true with status=proposed', async () => {
      const p = makePrisma({
        trackedWallet: {
          upsert: vi.fn().mockResolvedValue(rawRow),
        },
      });
      const r = new WalletsRepository(p);
      const result = await r.proposeWallet({ address: '0xabc', chain: 'base' });
      expect(result.ok).toBe(true);
      expect(result.status).toBe('proposed');
      expect(result.source).toBe('agent');
    });
  });

  describe('updateScore()', () => {
    it('increments retry_count when status=failed', async () => {
      await repo.updateScore('0xabc', 'base', { status: 'failed' });
      const call = (prisma.trackedWallet.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: { retryCount: number };
      };
      // rawRow.retryCount is 0, so after increment it should be 1
      expect(call.data.retryCount).toBe(1);
    });

    it('does not increment retry_count when status=scored', async () => {
      await repo.updateScore('0xabc', 'base', { status: 'scored' });
      const call = (prisma.trackedWallet.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: { retryCount: number };
      };
      expect(call.data.retryCount).toBe(0);
    });

    it('throws NotFoundException when wallet not found', async () => {
      const p = makePrisma({
        trackedWallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WalletsRepository(p);
      await expect(r.updateScore('0xmissing', 'base', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('remove()', () => {
    it('returns ok=true on success', async () => {
      const result = await repo.remove('0xabc', 'base');
      expect(result.ok).toBe(true);
    });

    it('throws NotFoundException when wallet not found', async () => {
      const p = makePrisma({
        trackedWallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: vi.fn(),
        },
      });
      const r = new WalletsRepository(p);
      await expect(r.remove('0xmissing', 'base')).rejects.toThrow(NotFoundException);
    });
  });
});
