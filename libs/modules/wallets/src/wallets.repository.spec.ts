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

  // ---------------------------------------------------------------------------
  // Adversarial: score_breakdown XSS round-trip (coder-flagged scenario 3)
  // ---------------------------------------------------------------------------

  describe('score_breakdown XSS round-trip contract', () => {
    it('stores XSS-shaped string as-is when score_breakdown is already a string', async () => {
      const xssPayload = '{"key": "<script>alert(1)</script>"}';
      await repo.upsertWallet({ address: '0xabc', chain: 'base', score_breakdown: xssPayload });
      const upsertCall = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { scoreBreakdown: string };
      };
      // Must be stored verbatim — no HTML encoding, no stripping, no parsing
      expect(upsertCall.create.scoreBreakdown).toBe(xssPayload);
    });

    it('serialises XSS object payload to JSON string without encoding (raw storage contract)', async () => {
      const xssObj = { key: '<script>alert(1)</script>' };
      await repo.upsertWallet({ address: '0xabc', chain: 'base', score_breakdown: xssObj });
      const upsertCall = (prisma.trackedWallet.upsert as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        create: { scoreBreakdown: string };
      };
      // Stored as JSON.stringify — angle brackets remain unescaped (raw storage, consumers escape on output)
      expect(upsertCall.create.scoreBreakdown).toBe(JSON.stringify(xssObj));
      expect(upsertCall.create.scoreBreakdown).toContain('<script>');
    });

    it('mapRow returns score_breakdown XSS string verbatim (no re-encoding on read)', async () => {
      const xssPayload = '{"key": "<script>alert(1)</script>"}';
      const p = makePrisma({
        trackedWallet: {
          findMany: vi.fn().mockResolvedValue([{ ...rawRow, scoreBreakdown: xssPayload }]),
          findUnique: vi.fn().mockResolvedValue({ ...rawRow, scoreBreakdown: xssPayload }),
        },
      });
      const r = new WalletsRepository(p);
      const result = await r.findMany({});
      expect(result[0]!.score_breakdown).toBe(xssPayload);
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial: PATCH on non-existent wallet (coder-flagged scenario 4)
  // ---------------------------------------------------------------------------

  describe('updateScore() on non-existent wallet — 404 not 500', () => {
    it('throws NotFoundException (not unhandled 500) for non-existent wallet', async () => {
      const p = makePrisma({
        trackedWallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WalletsRepository(p);
      const err = await r.updateScore('0xghost', 'solana', { status: 'scored' }).catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      // Crucially: update must NOT have been called
      expect(p.trackedWallet.update).not.toHaveBeenCalled();
    });

    it('updateScore with score_breakdown as object serialises to JSON string', async () => {
      await repo.updateScore('0xabc', 'base', { status: 'scored', score_breakdown: { birdeye: 90 } });
      const call = (prisma.trackedWallet.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: { scoreBreakdown: string };
      };
      expect(call.data.scoreBreakdown).toBe('{"birdeye":90}');
    });

    it('updateScore with score_breakdown as string passes through unchanged', async () => {
      await repo.updateScore('0xabc', 'base', { status: 'scored', score_breakdown: '{"birdeye":88}' });
      const call = (prisma.trackedWallet.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: { scoreBreakdown: string };
      };
      expect(call.data.scoreBreakdown).toBe('{"birdeye":88}');
    });

    it('updateScore sets scoreBreakdown to null when score_breakdown not provided', async () => {
      await repo.updateScore('0xabc', 'base', { status: 'scored' });
      const call = (prisma.trackedWallet.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: { scoreBreakdown: null };
      };
      expect(call.data.scoreBreakdown).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial: DELETE on non-existent wallet (coder-flagged scenario 5)
  // ---------------------------------------------------------------------------

  describe('remove() on non-existent wallet — 404 not 500', () => {
    it('throws NotFoundException (not unhandled 500) for non-existent wallet', async () => {
      const p = makePrisma({
        trackedWallet: {
          findUnique: vi.fn().mockResolvedValue(null),
          delete: vi.fn(),
        },
      });
      const r = new WalletsRepository(p);
      const err = await r.remove('0xghost', 'arbitrum').catch((e) => e);
      expect(err).toBeInstanceOf(NotFoundException);
      // delete must NOT have been called on non-existent row
      expect(p.trackedWallet.delete).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // findUnscored() — now uses Prisma findMany (Concern 2 fix: was $queryRaw)
  //
  // The previous $queryRaw<TrackedWallet[]> implementation returned physical
  // SQLite column names (retry_count, score_breakdown) but mapRow() accessed
  // camelCase keys (retryCount, scoreBreakdown), producing undefined values.
  // Replacing with findMany lets Prisma handle the mapping; the tests below
  // verify the correct Prisma call shape and that mapping still works.
  // ---------------------------------------------------------------------------

  describe('findUnscored() — mixed proposed + failed rows', () => {
    it('maps Prisma findMany rows correctly (camelCase keys → snake_case response)', async () => {
      const proposed = { ...rawRow, status: 'proposed', retryCount: 0 };
      const failedRetry1 = { ...rawRow, address: '0xfailed1', status: 'failed', retryCount: 1 };
      const failedRetry3 = { ...rawRow, address: '0xfailed3', status: 'failed', retryCount: 3 };

      const p = makePrisma({
        trackedWallet: {
          findMany: vi.fn().mockResolvedValue([proposed, failedRetry1, failedRetry3]),
          findUnique: vi.fn().mockResolvedValue(rawRow),
          upsert: vi.fn().mockResolvedValue(rawRow),
          update: vi.fn().mockResolvedValue(rawRow),
          delete: vi.fn().mockResolvedValue(rawRow),
        },
      });
      const r = new WalletsRepository(p);

      const result = await r.findUnscored(10);
      expect(result).toHaveLength(3);
      // Filtering is done by Prisma WHERE; all returned rows are mapped
      expect(result[0]!.status).toBe('proposed');
      // Crucially: retry_count must be a real number, not undefined (the bug this fixes)
      expect(result[0]!.retry_count).toBe(0);
      expect(result[1]!.status).toBe('failed');
      expect(result[1]!.retry_count).toBe(1);
      expect(result[2]!.retry_count).toBe(3);
    });

    it('passes correct WHERE and take=5 to findMany when no argument given', async () => {
      const p = makePrisma({
        trackedWallet: {
          findMany: vi.fn().mockResolvedValue([]),
          findUnique: vi.fn(),
          upsert: vi.fn(),
          update: vi.fn(),
          delete: vi.fn(),
        },
      });
      const r = new WalletsRepository(p);
      const result = await r.findUnscored();
      expect(Array.isArray(result)).toBe(true);
      expect(p.trackedWallet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [{ status: 'proposed' }, { AND: [{ status: 'failed' }, { retryCount: { lt: 3 } }] }],
          },
          take: 5,
          orderBy: { createdAt: 'asc' },
        }),
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Composite-key URL: Solana address (coder-flagged check 6)
  // ---------------------------------------------------------------------------

  describe('findOne() with Solana-shaped address', () => {
    it('passes a 44-char base58 address unchanged to prisma', async () => {
      const solanaAddr = '9Fqk5XNRiVQJn8FNnFrJGALvYVBp4eFLhSCCCCCCCCCC'; // 44 chars
      await repo.findOne(solanaAddr, 'solana');
      expect(prisma.trackedWallet.findUnique).toHaveBeenCalledWith({
        where: { address_chain: { address: solanaAddr, chain: 'solana' } },
      });
    });
  });
});
