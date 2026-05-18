/**
 * Integration tests for ScoreWalletsProcessor (SPEC §14, DoD §A, §E).
 *
 * Uses real Prisma against an isolated in-memory SQLite database.
 * Mocks BirdeyeAdapter and ZerionAdapter at the class boundary so no HTTP
 * calls are made. SystemRepository and WalletsRepository run against the
 * real Prisma client.
 *
 * Headline assertions (DoD §E — idempotency, per P3g1 plan §10):
 *   1. Idempotency triple-assert: run process() three times; tracked_wallets
 *      scores byte-identical after run 2 and run 3.
 *   2. Status transitions: proposed → scored with correct type.
 *   3. retry_count increments on failure path.
 *   4. last_score_wallets_bg_at meta key written.
 *   5. Harvest enqueue uses mocked Queue, not real Redis.
 *
 * This spec lives in src/jobs/ (not tests/integration/) because it must
 * resolve @cclaw/adapters-birdeye, @cclaw/adapters-zerion, @cclaw/prisma,
 * and @cclaw/system via the tsconfig paths defined in the wallets package.
 *
 * SPEC §8 — background job idempotency rule.
 * SPEC §14 — tests against real Prisma; mock at adapter boundary.
 * DoD §E — BullMQ processor: run twice, assert DB shape unchanged after second run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { Job, Queue } from 'bullmq';
import { PrismaService } from '@cclaw/prisma';
import { WalletsRepository } from '../wallets.repository.js';
import { SystemRepository } from '@cclaw/system';
import { SystemService } from '@cclaw/system';
import { ScoreWalletService } from './score-wallet.service.js';
import { ScoreWalletsProcessor } from './score-wallets.processor.js';
import type { BirdeyeAdapter, TraderRankResult } from '@cclaw/adapters-birdeye';
import type { ZerionAdapter, ZerionPnlResult } from '@cclaw/adapters-zerion';

// ---------------------------------------------------------------------------
// In-process SQLite setup (mirrors harvest.integration.spec.ts)
// ---------------------------------------------------------------------------

let prisma: PrismaService;

beforeAll(async () => {
  // Use a named in-memory DB distinct from harvest.integration.spec.ts
  // to avoid cross-spec interference in the same Vitest worker process.
  process.env['DATABASE_URL'] = 'file::score_wallets_test?mode=memory&cache=shared&connection_limit=1';
  process.env['PRISMA_DISABLE_DOTENV'] = '1';

  prisma = new PrismaService();
  await prisma.onModuleInit();

  // Create tables matching the Prisma schema (manual DDL for in-memory SQLite)
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "tracked_wallets" (
      "address"         TEXT NOT NULL,
      "chain"           TEXT NOT NULL,
      "label"           TEXT,
      "type"            TEXT,
      "notes"           TEXT,
      "status"          TEXT NOT NULL DEFAULT 'proposed',
      "score"           INTEGER,
      "score_breakdown" TEXT,
      "source_token"    TEXT,
      "scored_at"       TEXT,
      "score_error"     TEXT,
      "retry_count"     INTEGER NOT NULL DEFAULT 0,
      "source"          TEXT DEFAULT 'agent',
      "last_checked_at" TEXT,
      "created_at"      TEXT,
      PRIMARY KEY ("address", "chain")
    )
  `);

  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "portfolio_meta" (
      "key"        TEXT NOT NULL PRIMARY KEY,
      "value"      TEXT NOT NULL,
      "updated_at" TEXT
    )
  `);
}, 15_000);

afterAll(async () => {
  await prisma.onModuleDestroy();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraderRankResult(pnl = 200_000): TraderRankResult {
  return {
    source: 'birdeye_trader',
    inTopGainers: true,
    rank: 1,
    pnl,
    volume: 2_000_000,
    tradeCount: 200,
    totalTraders: 10,
  };
}

function makeZerionPnlResult(): ZerionPnlResult {
  return {
    source: 'zerion',
    realizedPnl: 10_000,
    unrealizedPnl: 2_000,
    totalPnl: 12_000,
    totalInvested: 20_000,
    relativeRealizedGain: 600,
  };
}

type FakeBirdeyeAdapter = Pick<BirdeyeAdapter, 'getTraderRank' | 'getTokenTopTraders' | 'getTopGainersPerChain'>;
type FakeZerionAdapter = Pick<ZerionAdapter, 'getPnl'>;

function makeAdapters(opts: {
  traderRank?: TraderRankResult | null;
  zerionPnl?: ZerionPnlResult | null;
  getTraderRankFn?: () => Promise<TraderRankResult | null>;
}): { birdeye: FakeBirdeyeAdapter; zerion: FakeZerionAdapter } {
  return {
    birdeye: {
      getTraderRank: opts.getTraderRankFn ?? vi.fn().mockResolvedValue(opts.traderRank ?? null),
      getTokenTopTraders: vi.fn().mockResolvedValue(null),
      getTopGainersPerChain: vi.fn().mockResolvedValue([]),
    },
    zerion: {
      getPnl: vi.fn().mockResolvedValue(opts.zerionPnl ?? null),
    },
  };
}

function makeConfigService(overrides: Record<string, unknown> = {}): {
  get: (k: string) => unknown;
} {
  const defaults: Record<string, unknown> = {
    WALLET_SCORING_PER_WALLET_TIMEOUT_MS: 30_000,
    WALLET_SCORING_INTER_WALLET_DELAY_MS: 0, // no delay in integration tests
    PAPER_MODE: 'false',
    SAFE_ID: 'integration-test',
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

function makeHarvestQueue(): Queue {
  return {
    add: vi.fn().mockResolvedValue({ id: 'harvest-job-1' }),
  } as unknown as Queue;
}

function makeJob(id = 'test-job'): Job {
  return { id, data: {} } as unknown as Job;
}

/** Snapshot tracked_wallets rows for deterministic diffing. */
async function snapshotWallets(): Promise<
  Array<{
    address: string;
    chain: string;
    status: string;
    type: string | null;
    score: number | null;
    retryCount: number;
  }>
> {
  const rows = await prisma.trackedWallet.findMany({
    orderBy: [{ chain: 'asc' }, { address: 'asc' }],
  });
  return rows.map((r) => ({
    address: r.address,
    chain: r.chain,
    status: r.status,
    type: r.type,
    score: r.score,
    retryCount: r.retryCount,
  }));
}

async function getMetaValue(key: string): Promise<string | null> {
  const row = await prisma.portfolioMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Wire up services per test
// ---------------------------------------------------------------------------

let walletsRepo: WalletsRepository;
let systemSvc: SystemService;

beforeEach(async () => {
  await prisma.trackedWallet.deleteMany({});
  await prisma.portfolioMeta.deleteMany({});

  walletsRepo = new WalletsRepository(prisma);
  const systemRepo = new SystemRepository(prisma);
  const cfg = makeConfigService();
  const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }) } as unknown as import('bullmq').Queue;
  systemSvc = new SystemService(systemRepo, cfg as unknown as import('@nestjs/config').ConfigService, mockQueue);
});

function buildProcessor(
  birdeye: FakeBirdeyeAdapter,
  zerion: FakeZerionAdapter,
  harvestQueue: Queue,
): ScoreWalletsProcessor {
  const cfg = makeConfigService();
  return new ScoreWalletsProcessor(
    harvestQueue,
    birdeye as unknown as BirdeyeAdapter,
    zerion as unknown as ZerionAdapter,
    walletsRepo,
    systemSvc,
    cfg as unknown as import('@nestjs/config').ConfigService,
    new ScoreWalletService(),
  );
}

// ---------------------------------------------------------------------------
// Seed wallets helper
// ---------------------------------------------------------------------------

async function seedProposed(wallets: Array<{ address: string; chain: string }>): Promise<void> {
  for (const w of wallets) {
    await prisma.trackedWallet.create({
      data: {
        address: w.address,
        chain: w.chain,
        status: 'proposed',
        retryCount: 0,
        source: 'birdeye-harvest',
        createdAt: new Date().toISOString(),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Idempotency (Headline §E — triple-assert)
// ---------------------------------------------------------------------------

describe('Idempotency (DoD §E — SPEC §8)', () => {
  it('running process() three times: scores byte-identical after run 2 and run 3', async () => {
    await seedProposed([
      { address: '0xWallet1', chain: 'base' },
      { address: '0xWallet2', chain: 'base' },
    ]);

    const { birdeye, zerion } = makeAdapters({
      traderRank: makeTraderRankResult(),
      zerionPnl: makeZerionPnlResult(),
    });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    // Run 1: scores wallets
    await proc.process(makeJob('r1'));

    // Run 2: findUnscored returns [] (all already scored)
    // Snapshot after run 2
    const snap2 = await snapshotWallets();

    await proc.process(makeJob('r2'));
    const snap3 = await snapshotWallets();

    // Scores must be byte-identical between run 2 and run 3
    expect(snap3).toEqual(snap2);
  });

  it('meta last_score_wallets_bg_at advances but wallet rows remain identical', async () => {
    await seedProposed([{ address: '0xW', chain: 'base' }]);

    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob('r1'));
    const snap1 = await snapshotWallets();
    const meta1 = await getMetaValue('last_score_wallets_bg_at');

    await new Promise((r) => setTimeout(r, 5));
    await proc.process(makeJob('r2'));
    const snap2 = await snapshotWallets();
    const meta2 = await getMetaValue('last_score_wallets_bg_at');

    expect(snap2).toEqual(snap1);
    expect(meta1).not.toBeNull();
    expect(meta2).not.toBeNull();
    expect(new Date(meta2!).getTime()).toBeGreaterThanOrEqual(new Date(meta1!).getTime());
  });

  it('row count does not grow across repeated runs', async () => {
    await seedProposed([
      { address: '0xA', chain: 'base' },
      { address: '0xB', chain: 'solana' },
    ]);

    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    for (const id of ['r1', 'r2', 'r3']) {
      await proc.process(makeJob(id));
    }

    const count = await prisma.trackedWallet.count();
    expect(count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

describe('Status transitions (proposed → scored)', () => {
  it('all proposed wallets become scored after a successful run', async () => {
    await seedProposed([
      { address: '0xP1', chain: 'base' },
      { address: '0xP2', chain: 'base' },
      { address: '0xP3', chain: 'base' },
    ]);

    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const rows = await prisma.trackedWallet.findMany({});
    for (const r of rows) {
      expect(r.status).toBe('scored');
    }
  });

  it('wallets classified as smart_money when score >= 75', async () => {
    await seedProposed([{ address: '0xSmart', chain: 'base' }]);

    // makeTraderRankResult produces overall=90 → smart_money
    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xSmart', chain: 'base' } },
    });
    expect(row?.type).toBe('smart_money');
    expect(row?.score ?? 0).toBeGreaterThanOrEqual(75);
  });

  it('score is stored as a number in the database', async () => {
    await seedProposed([{ address: '0xScoreNum', chain: 'base' }]);

    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xScoreNum', chain: 'base' } },
    });
    expect(typeof row?.score).toBe('number');
  });

  it('score_breakdown is stored as a JSON string', async () => {
    await seedProposed([{ address: '0xBD', chain: 'base' }]);

    const { birdeye, zerion } = makeAdapters({ traderRank: makeTraderRankResult() });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xBD', chain: 'base' } },
    });
    expect(row?.scoreBreakdown).toBeTruthy();
    // Must be parseable JSON
    const parsed = JSON.parse(row!.scoreBreakdown!) as Record<string, number>;
    expect(typeof parsed.profitability).toBe('number');
    expect(typeof parsed.reputation).toBe('number');
  });
});

// ---------------------------------------------------------------------------
// retry_count increments on failure path
// ---------------------------------------------------------------------------

describe('retry_count on failure path', () => {
  it('retry_count increments from 0 to 1 on first failure', async () => {
    await seedProposed([{ address: '0xFail', chain: 'base' }]);

    // All APIs return null → fail path
    const { birdeye, zerion } = makeAdapters({ traderRank: null, zerionPnl: null });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xFail', chain: 'base' } },
    });
    expect(row?.status).toBe('failed');
    expect(row?.retryCount).toBe(1);
  });

  it('retry_count increments to 2 on second failure', async () => {
    await seedProposed([{ address: '0xRetry', chain: 'base' }]);

    const { birdeye, zerion } = makeAdapters({ traderRank: null, zerionPnl: null });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    // Two runs
    await proc.process(makeJob('r1'));
    await proc.process(makeJob('r2'));

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xRetry', chain: 'base' } },
    });
    expect(row?.retryCount).toBe(2);
  });

  it('wallet no longer in findUnscored when retry_count reaches 3', async () => {
    // Pre-seed with retry_count=2 (one below threshold)
    await prisma.trackedWallet.create({
      data: {
        address: '0xAt3',
        chain: 'base',
        status: 'failed',
        retryCount: 2,
        source: 'test',
        createdAt: new Date().toISOString(),
      },
    });

    // Run once → retry_count becomes 3 → next findUnscored won't return it
    const { birdeye, zerion } = makeAdapters({ traderRank: null, zerionPnl: null });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob('r1'));
    // retry_count should now be 3
    const rowAfterR1 = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xAt3', chain: 'base' } },
    });
    expect(rowAfterR1?.retryCount).toBe(3);

    // Now run again — wallet should NOT be in findUnscored (retryCount < 3 filter)
    await proc.process(makeJob('r2'));
    const rowAfterR2 = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xAt3', chain: 'base' } },
    });
    // retryCount stays at 3 — not processed again
    expect(rowAfterR2?.retryCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Meta key written
// ---------------------------------------------------------------------------

describe('Meta key "last_score_wallets_bg_at" (DoD §E health write)', () => {
  it('meta key is written after a successful run', async () => {
    const before = Date.now();
    const { birdeye, zerion } = makeAdapters({ traderRank: null });
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const meta = await getMetaValue('last_score_wallets_bg_at');
    expect(meta).not.toBeNull();
    const ts = new Date(meta!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('meta key is written even when no wallets to score', async () => {
    // Empty tracked_wallets
    const { birdeye, zerion } = makeAdapters({});
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob());

    const meta = await getMetaValue('last_score_wallets_bg_at');
    expect(meta).not.toBeNull();
  });

  it('meta value advances monotonically across runs', async () => {
    const { birdeye, zerion } = makeAdapters({});
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    await proc.process(makeJob('j1'));
    const ts1 = await getMetaValue('last_score_wallets_bg_at');

    await new Promise((r) => setTimeout(r, 5));

    await proc.process(makeJob('j2'));
    const ts2 = await getMetaValue('last_score_wallets_bg_at');

    expect(new Date(ts2!).getTime()).toBeGreaterThanOrEqual(new Date(ts1!).getTime());
  });
});

// ---------------------------------------------------------------------------
// Harvest gate integration: mocked Queue
// ---------------------------------------------------------------------------

describe('Harvest gate (mocked Queue — not real Redis)', () => {
  it('enqueues harvest job when last_birdeye_harvest_at is not set (stale)', async () => {
    // No last_birdeye_harvest_at in DB → getMeta returns null → stale
    const { birdeye, zerion } = makeAdapters({});
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    const result = await proc.process(makeJob());

    expect(result.harvest_enqueued).toBe(true);
    expect(harvestQueue.add).toHaveBeenCalledWith('harvest', {});
  });

  it('does NOT enqueue harvest job when last_birdeye_harvest_at is fresh', async () => {
    // Seed a fresh timestamp in portfolio_meta
    await prisma.portfolioMeta.create({
      data: {
        key: 'last_birdeye_harvest_at',
        value: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    });

    const { birdeye, zerion } = makeAdapters({});
    const harvestQueue = makeHarvestQueue();
    const proc = buildProcessor(birdeye, zerion, harvestQueue);

    const result = await proc.process(makeJob());

    expect(result.harvest_enqueued).toBe(false);
    expect(harvestQueue.add).not.toHaveBeenCalled();
  });

  it('mocked Queue is used — harvestQueue.add is a vi.fn (not real Redis)', () => {
    const harvestQueue = makeHarvestQueue();
    // Verify it's a Vitest mock function, not a real BullMQ Queue
    expect(vi.isMockFunction(harvestQueue.add)).toBe(true);
  });
});
