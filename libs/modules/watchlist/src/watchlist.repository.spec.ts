/**
 * Unit tests for WatchlistRepository (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { WatchlistRepository } from './watchlist.repository.js';
import type { PrismaService } from '@cclaw/prisma';

const rawRow = {
  id: 'watch-1',
  symbol: 'ETH',
  address: '0xtoken',
  chain: 'base',
  targetEntry: 2000.0,
  currentPrice: 2100.0,
  analysisScore: 80,
  riskScore: 20,
  narrative: 'ETH narrative',
  reason: 'Strong fundamentals',
  expiresAt: null,
  status: 'watching',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function makePrisma(overrides?: Record<string, unknown>): PrismaService {
  return {
    watchlist: {
      findMany: vi.fn().mockResolvedValue([rawRow]),
      findUnique: vi.fn().mockResolvedValue(rawRow),
      create: vi.fn().mockResolvedValue(rawRow),
      update: vi.fn().mockResolvedValue({ ...rawRow, status: 'removed' }),
    },
    ...overrides,
  } as unknown as PrismaService;
}

describe('WatchlistRepository', () => {
  let repo: WatchlistRepository;
  let prisma: PrismaService;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new WatchlistRepository(prisma);
  });

  describe('findMany()', () => {
    it('returns all rows when status is not specified', async () => {
      const result = await repo.findMany({});
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: unknown;
      };
      expect(call.where).toBeUndefined();
      expect(Array.isArray(result)).toBe(true);
    });

    it('filters by status when status="watching"', async () => {
      await repo.findMany({ status: 'watching' });
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ status: 'watching' });
    });

    it('returns all rows when status="all"', async () => {
      await repo.findMany({ status: 'all' });
      const call = (prisma.watchlist.findMany as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        where: unknown;
      };
      expect(call.where).toBeUndefined();
    });

    it('maps camelCase to snake_case in response', async () => {
      const result = await repo.findMany({});
      const r = result[0]!;
      expect(r.analysis_score).toBe(80);
      expect(r.target_entry).toBe(2000.0);
    });
  });

  describe('findById()', () => {
    it('returns the mapped watchlist entry', async () => {
      const result = await repo.findById('watch-1');
      expect(result.id).toBe('watch-1');
      expect(result.symbol).toBe('ETH');
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: { findUnique: vi.fn().mockResolvedValue(null) },
      });
      const r = new WatchlistRepository(p);
      await expect(r.findById('missing')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('inserts the entry and returns the mapped row', async () => {
      const dto = {
        id: 'watch-1',
        symbol: 'ETH',
        address: '0xtoken',
        chain: 'base',
      };
      const result = await repo.create(dto);
      expect(result.id).toBe('watch-1');
      const call = (prisma.watchlist.create as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe('watching');
    });
  });

  describe('update()', () => {
    it('updates fields and returns the mapped row', async () => {
      const result = await repo.update('watch-1', { current_price: 2200 });
      expect(result).toBeDefined();
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WatchlistRepository(p);
      await expect(r.update('missing', {})).rejects.toThrow(NotFoundException);
    });
  });

  describe('softDelete()', () => {
    it('sets status=removed and returns ok=true', async () => {
      const result = await repo.softDelete('watch-1');
      expect(result.ok).toBe(true);
      expect(result.id).toBe('watch-1');
      const call = (prisma.watchlist.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.status).toBe('removed');
    });

    it('throws NotFoundException when entry not found', async () => {
      const p = makePrisma({
        watchlist: {
          findUnique: vi.fn().mockResolvedValue(null),
          update: vi.fn(),
        },
      });
      const r = new WatchlistRepository(p);
      await expect(r.softDelete('missing')).rejects.toThrow(NotFoundException);
    });
  });

  // ---------------------------------------------------------------------------
  // Adversarial: soft-delete idempotency (coder-flagged check 4)
  //
  // The repository's softDelete() checks for row existence via findUnique, then
  // calls update(). After the first delete the row still exists with status='removed'.
  // A second call to softDelete() must succeed because the row is still findable.
  // This is the expected soft-delete contract: no 404 on the second call.
  // ---------------------------------------------------------------------------

  describe('softDelete() idempotency', () => {
    it('second soft-delete on already-removed entry succeeds (row still findable)', async () => {
      // After the first delete the row persists with status='removed'.
      // makePrisma() returns rawRow on findUnique (status='watching') but we simulate
      // a row that already has status='removed'.
      const alreadyRemovedRow = { ...rawRow, status: 'removed' };
      const p = makePrisma({
        watchlist: {
          findUnique: vi.fn().mockResolvedValue(alreadyRemovedRow),
          update: vi.fn().mockResolvedValue(alreadyRemovedRow),
        },
      });
      const r = new WatchlistRepository(p);
      // Second call: row exists (status=removed) → findUnique returns it → update proceeds
      const result = await r.softDelete('watch-1');
      expect(result.ok).toBe(true);
      expect(result.id).toBe('watch-1');
    });

    it('does NOT throw when called twice on the same entry', async () => {
      // Simulate the first call: row exists → soft-deleted
      await repo.softDelete('watch-1');
      // Simulate the second call: row still exists (with removed status)
      // The mock always returns rawRow for findUnique, so the second call also succeeds.
      await expect(repo.softDelete('watch-1')).resolves.toMatchObject({ ok: true, id: 'watch-1' });
    });
  });

  // ---------------------------------------------------------------------------
  // Coverage: mapRow null branches (watchlist.repository.ts lines 25-34)
  // ---------------------------------------------------------------------------

  describe('mapRow with all-null optional fields', () => {
    it('returns null for all optional fields when they are null in the DB row', async () => {
      const minimalRow = {
        id: 'min-1',
        symbol: 'SOL',
        address: '0xsol',
        chain: 'solana',
        targetEntry: null,
        currentPrice: null,
        analysisScore: null,
        riskScore: null,
        narrative: null,
        reason: null,
        expiresAt: null,
        status: 'watching',
        createdAt: null,
        updatedAt: null,
      };
      const p = makePrisma({
        watchlist: {
          findMany: vi.fn().mockResolvedValue([minimalRow]),
          findUnique: vi.fn().mockResolvedValue(minimalRow),
          create: vi.fn(),
          update: vi.fn(),
        },
      });
      const r = new WatchlistRepository(p);
      const result = await r.findMany({});
      const row = result[0]!;
      expect(row.target_entry).toBeNull();
      expect(row.current_price).toBeNull();
      expect(row.analysis_score).toBeNull();
      expect(row.risk_score).toBeNull();
      expect(row.narrative).toBeNull();
      expect(row.reason).toBeNull();
      expect(row.expires_at).toBeNull();
      expect(row.created_at).toBeNull();
      expect(row.updated_at).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Coverage: update() conditional field spreading (lines 102-112)
  // ---------------------------------------------------------------------------

  describe('update() conditional field spreading', () => {
    it('includes all optional fields in update data when all are provided', async () => {
      const fullDto = {
        symbol: 'BTC',
        address: '0xbtc',
        chain: 'eth',
        target_entry: 50000,
        current_price: 52000,
        analysis_score: 85,
        risk_score: 15,
        narrative: 'digital gold',
        reason: 'store of value',
        expires_at: '2026-12-31',
        status: 'entry_hit',
      };
      await repo.update('watch-1', fullDto);
      const call = (prisma.watchlist.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.symbol).toBe('BTC');
      expect(call.data.address).toBe('0xbtc');
      expect(call.data.chain).toBe('eth');
      expect(call.data.targetEntry).toBe(50000);
      expect(call.data.currentPrice).toBe(52000);
      expect(call.data.analysisScore).toBe(85);
      expect(call.data.riskScore).toBe(15);
      expect(call.data.narrative).toBe('digital gold');
      expect(call.data.reason).toBe('store of value');
      expect(call.data.expiresAt).toBe('2026-12-31');
      expect(call.data.status).toBe('entry_hit');
    });

    it('omits undefined fields from update data (only updated_at is always set)', async () => {
      // Only update current_price — all other fields are undefined
      await repo.update('watch-1', { current_price: 2500 });
      const call = (prisma.watchlist.update as ReturnType<typeof vi.fn>).mock.calls[0]![0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.currentPrice).toBe(2500);
      expect(call.data.symbol).toBeUndefined();
      expect(call.data.address).toBeUndefined();
      expect(call.data.chain).toBeUndefined();
      expect(call.data.updatedAt).toBeDefined();
    });
  });
});
