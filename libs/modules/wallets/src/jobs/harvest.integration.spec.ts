/**
 * Integration tests for HarvestProcessor (SPEC §14, DoD §A, §E).
 *
 * Uses real Prisma against an isolated in-memory SQLite database.
 * Mocks BirdeyeAdapter at the class boundary so no HTTP calls are made.
 * SystemRepository and WalletsRepository run against the real Prisma client.
 *
 * Headline assertions (DoD §E — idempotency, per P3g1 plan §10):
 *   1. Idempotency: run process() twice → only last_birdeye_harvest_at changes.
 *      tracked_wallets row count, addresses, statuses must be byte-identical.
 *   2. Retry idempotency: partial-failure run + retry → same final DB state.
 *   3. Status='proposed': every inserted row has status='proposed'.
 *   4. Meta key written: last_birdeye_harvest_at is a recent ISO timestamp.
 *
 * This spec lives in src/jobs/ (not tests/integration/) because it must
 * resolve @cclaw/adapters-birdeye, @cclaw/prisma, and @cclaw/system via the
 * tsconfig paths defined in libs/modules/wallets/tsconfig.json. The wallets
 * vitest config (wallets:unit) covers src/**‌/*.spec.ts, which includes this
 * file. Coverage still flows to the processor file under test.
 *
 * SPEC §8 — background job idempotency rule.
 * SPEC §14 — tests against real Prisma; mock at adapter boundary.
 * DoD §E — BullMQ processor: run twice, assert DB shape unchanged after second run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { Job } from 'bullmq';
import type { TopGainerEntry } from '@cclaw/adapters-birdeye';
import { BirdeyeApiKeyMissingError } from '@cclaw/adapters-birdeye';
import { PrismaService } from '@cclaw/prisma';
import { WalletsRepository } from '../wallets.repository.js';
import { SystemRepository } from '@cclaw/system';
import { SystemService } from '@cclaw/system';
import { HarvestProcessor } from './harvest.processor.js';

// ---------------------------------------------------------------------------
// In-process SQLite setup (mirrors libs/prisma/src/prisma.service.spec.ts)
// ---------------------------------------------------------------------------

let prisma: PrismaService;

beforeAll(async () => {
  // Use an isolated in-memory SQLite — no file on disk; isolated per suite.
  process.env['DATABASE_URL'] = 'file::memory:?connection_limit=1';
  process.env['PRISMA_DISABLE_DOTENV'] = '1';

  prisma = new PrismaService();
  await prisma.onModuleInit();

  // Create the tables the processor writes to (Prisma migrate not available in unit context).
  // Keep in sync with the Prisma schema.
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

type FakeBirdeyeAdapter = {
  getTopGainersPerChain: (chains: string[], opts?: unknown) => Promise<TopGainerEntry[]>;
};

function makeAdapter(tokens: TopGainerEntry[]): FakeBirdeyeAdapter {
  return {
    getTopGainersPerChain: async () => tokens,
  };
}

function makeConfigService(overrides: Record<string, unknown> = {}): { get: (k: string) => unknown } {
  const defaults: Record<string, unknown> = {
    ACTIVE_CHAINS: 'base,solana',
    WALLET_HARVEST_TIMEOUT_MS: 30_000,
    PAPER_MODE: 'false',
    SAFE_ID: 'integration-test',
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

function makeJob(id = 'test-job'): Job {
  return { id, data: {} } as unknown as Job;
}

function buildProcessor(
  adapter: FakeBirdeyeAdapter,
  repo: WalletsRepository,
  svc: SystemService,
  configOverrides: Record<string, unknown> = {},
): HarvestProcessor {
  const cfg = makeConfigService(configOverrides);
  return new HarvestProcessor(
    adapter as unknown as import('@cclaw/adapters-birdeye').BirdeyeAdapter,
    repo,
    svc,
    cfg as unknown as import('@nestjs/config').ConfigService,
  );
}

// Snapshot rows for diffing (order-stable)
async function snapshotWallets(): Promise<
  Array<{
    address: string;
    chain: string;
    status: string;
    source: string | null;
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
    source: r.source,
    retryCount: r.retryCount,
  }));
}

async function getMetaValue(key: string): Promise<string | null> {
  const row = await prisma.portfolioMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Wire up services
// ---------------------------------------------------------------------------

let walletsRepo: WalletsRepository;
let systemSvc: SystemService;

beforeEach(async () => {
  // Isolate each test case
  await prisma.trackedWallet.deleteMany({});
  await prisma.portfolioMeta.deleteMany({});

  walletsRepo = new WalletsRepository(prisma);
  const systemRepo = new SystemRepository(prisma);
  const cfg = makeConfigService();
  systemSvc = new SystemService(systemRepo, cfg as unknown as import('@nestjs/config').ConfigService);
});

// ---------------------------------------------------------------------------
// Idempotency (Headline §E)
// ---------------------------------------------------------------------------

describe('Idempotency (DoD §E — SPEC §8)', () => {
  it('running process() twice leaves tracked_wallets identical (only meta timestamp changes)', async () => {
    const tokens: TopGainerEntry[] = [
      { address: '0xA', chain: 'base', symbol: 'A' },
      { address: '0xB', chain: 'base', symbol: 'B' },
      { address: 'SolX', chain: 'solana', symbol: 'X' },
    ];
    const proc = buildProcessor(makeAdapter(tokens), walletsRepo, systemSvc);

    await proc.process(makeJob('j1'));
    const snap1 = await snapshotWallets();
    const meta1 = await getMetaValue('last_birdeye_harvest_at');

    await new Promise((r) => setTimeout(r, 5)); // ensure clock advances
    await proc.process(makeJob('j2'));
    const snap2 = await snapshotWallets();
    const meta2 = await getMetaValue('last_birdeye_harvest_at');

    // tracked_wallets must be byte-identical
    expect(snap2).toEqual(snap1);

    // Meta timestamp advances (it is a live clock write)
    expect(meta1).not.toBeNull();
    expect(meta2).not.toBeNull();
    expect(new Date(meta2!).getTime()).toBeGreaterThanOrEqual(new Date(meta1!).getTime());
  });

  it('second run adds 0 new rows — INSERT OR IGNORE semantics', async () => {
    const tokens: TopGainerEntry[] = [
      { address: '0xC', chain: 'base', symbol: 'C' },
      { address: '0xD', chain: 'base', symbol: 'D' },
    ];
    const proc = buildProcessor(makeAdapter(tokens), walletsRepo, systemSvc);

    await proc.process(makeJob('j1'));
    const count1 = await prisma.trackedWallet.count();

    await proc.process(makeJob('j2'));
    const count2 = await prisma.trackedWallet.count();

    expect(count1).toBe(2);
    expect(count2).toBe(2);
  });

  it('triple run — count still equals token count (no growth)', async () => {
    const tokens: TopGainerEntry[] = [{ address: '0xE', chain: 'base', symbol: 'E' }];
    const proc = buildProcessor(makeAdapter(tokens), walletsRepo, systemSvc);

    for (const id of ['r1', 'r2', 'r3']) {
      await proc.process(makeJob(id));
    }

    expect(await prisma.trackedWallet.count()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Retry idempotency (DoD §E — BullMQ attempts:2 model)
// ---------------------------------------------------------------------------

describe('Retry idempotency (DoD §E — BullMQ retry model)', () => {
  it('partial-failure run (base OK, solana empty) + retry = same DB as first run', async () => {
    // Run 1: adapter returns base tokens only (solana "failed silently")
    const run1Tokens: TopGainerEntry[] = [{ address: '0xBaseOk', chain: 'base', symbol: 'BOK' }];
    const proc1 = buildProcessor(makeAdapter(run1Tokens), walletsRepo, systemSvc);
    await proc1.process(makeJob('retry-1'));
    const snapAfterRun1 = await snapshotWallets();

    // Run 2 (BullMQ retry after 60 s — we skip the wait): same response
    const proc2 = buildProcessor(makeAdapter(run1Tokens), walletsRepo, systemSvc);
    await proc2.process(makeJob('retry-2'));
    const snapAfterRun2 = await snapshotWallets();

    expect(snapAfterRun2).toEqual(snapAfterRun1);
  });

  it('retry with expanded adapter response adds only the new addresses', async () => {
    // Run 1: partial response
    const run1 = buildProcessor(
      makeAdapter([{ address: '0xPartial', chain: 'base', symbol: 'P' }]),
      walletsRepo,
      systemSvc,
    );
    await run1.process(makeJob('r1'));
    const countAfterRun1 = await prisma.trackedWallet.count();

    // Run 2: full response (includes run1 address plus new address)
    const run2 = buildProcessor(
      makeAdapter([
        { address: '0xPartial', chain: 'base', symbol: 'P' },
        { address: '0xNew', chain: 'base', symbol: 'N' },
      ]),
      walletsRepo,
      systemSvc,
    );
    await run2.process(makeJob('r2'));
    const countAfterRun2 = await prisma.trackedWallet.count();

    expect(countAfterRun1).toBe(1);
    expect(countAfterRun2).toBe(2); // only the new address was added
  });
});

// ---------------------------------------------------------------------------
// Headline assertion 3: status='proposed' invariant
// ---------------------------------------------------------------------------

describe('Status invariant (legacy parity — status="proposed")', () => {
  it('every inserted row has status="proposed"', async () => {
    const tokens: TopGainerEntry[] = [
      { address: '0xX', chain: 'base', symbol: 'X' },
      { address: '0xY', chain: 'solana', symbol: 'Y' },
    ];
    const proc = buildProcessor(makeAdapter(tokens), walletsRepo, systemSvc);

    await proc.process(makeJob());

    const rows = await prisma.trackedWallet.findMany({});
    for (const r of rows) {
      expect(r.status).toBe('proposed');
    }
  });

  it('source is stored as "birdeye-harvest" (not the default "agent")', async () => {
    const proc = buildProcessor(
      makeAdapter([{ address: '0xSrc', chain: 'base', symbol: 'S' }]),
      walletsRepo,
      systemSvc,
    );

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xSrc', chain: 'base' } },
    });
    expect(row?.source).toBe('birdeye-harvest');
  });

  it('pre-existing row with source="agent" is NOT overwritten (INSERT OR IGNORE)', async () => {
    // Pre-seed a manually-added wallet
    await prisma.trackedWallet.create({
      data: {
        address: '0xPre',
        chain: 'base',
        status: 'scored',
        source: 'agent',
        retryCount: 0,
        createdAt: new Date().toISOString(),
      },
    });

    const proc = buildProcessor(
      makeAdapter([{ address: '0xPre', chain: 'base', symbol: 'PRE' }]),
      walletsRepo,
      systemSvc,
    );

    await proc.process(makeJob());

    const row = await prisma.trackedWallet.findUnique({
      where: { address_chain: { address: '0xPre', chain: 'base' } },
    });
    // The existing row must be untouched
    expect(row?.source).toBe('agent');
    expect(row?.status).toBe('scored');
  });
});

// ---------------------------------------------------------------------------
// Headline assertion 4: meta key written
// ---------------------------------------------------------------------------

describe('Meta key "last_birdeye_harvest_at" (DoD §E health write)', () => {
  it('returns a recent ISO timestamp after a successful run', async () => {
    const before = Date.now();
    const proc = buildProcessor(makeAdapter([]), walletsRepo, systemSvc);

    await proc.process(makeJob());

    const meta = await getMetaValue('last_birdeye_harvest_at');
    expect(meta).not.toBeNull();
    const ts = new Date(meta!).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now() + 5000);
  });

  it('meta is written even for an empty adapter response', async () => {
    const proc = buildProcessor(makeAdapter([]), walletsRepo, systemSvc);

    await proc.process(makeJob());

    const meta = await getMetaValue('last_birdeye_harvest_at');
    expect(meta).not.toBeNull();
  });

  it('meta value advances monotonically across runs', async () => {
    const proc = buildProcessor(makeAdapter([]), walletsRepo, systemSvc);

    await proc.process(makeJob('j1'));
    const ts1 = await getMetaValue('last_birdeye_harvest_at');

    await new Promise((r) => setTimeout(r, 5));

    await proc.process(makeJob('j2'));
    const ts2 = await getMetaValue('last_birdeye_harvest_at');

    expect(new Date(ts2!).getTime()).toBeGreaterThanOrEqual(new Date(ts1!).getTime());
  });
});

// ---------------------------------------------------------------------------
// byChain breakdown
// ---------------------------------------------------------------------------

describe('byChain breakdown accuracy', () => {
  it('byChain counts match rows in tracked_wallets per chain', async () => {
    const tokens: TopGainerEntry[] = [
      { address: '0xB1', chain: 'base', symbol: 'B1' },
      { address: '0xB2', chain: 'base', symbol: 'B2' },
      { address: '0xS1', chain: 'solana', symbol: 'S1' },
    ];
    const proc = buildProcessor(makeAdapter(tokens), walletsRepo, systemSvc);

    const result = await proc.process(makeJob());

    const dbBase = await prisma.trackedWallet.count({ where: { chain: 'base' } });
    const dbSolana = await prisma.trackedWallet.count({ where: { chain: 'solana' } });
    expect(result.byChain['base']).toBe(dbBase);
    expect(result.byChain['solana']).toBe(dbSolana);
    expect(result.harvested).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Adapter error propagation (no DB mutation on uncaught error)
// ---------------------------------------------------------------------------

describe('Adapter error propagation', () => {
  it('does not insert rows when adapter throws BirdeyeApiKeyMissingError', async () => {
    const proc = buildProcessor(
      {
        getTopGainersPerChain: async () => {
          throw new BirdeyeApiKeyMissingError();
        },
      },
      walletsRepo,
      systemSvc,
    );

    await expect(proc.process(makeJob())).rejects.toThrow(BirdeyeApiKeyMissingError);

    expect(await prisma.trackedWallet.count()).toBe(0);
  });

  it('does not write last_birdeye_harvest_at when adapter throws', async () => {
    const proc = buildProcessor(
      {
        getTopGainersPerChain: async () => {
          throw new Error('timeout');
        },
      },
      walletsRepo,
      systemSvc,
    );

    await proc.process(makeJob()).catch(() => {});

    expect(await getMetaValue('last_birdeye_harvest_at')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Additive behavior
// ---------------------------------------------------------------------------

describe('Additive behavior across distinct runs', () => {
  it('new addresses from a subsequent run are added to tracked_wallets', async () => {
    const p1 = buildProcessor(
      makeAdapter([{ address: '0xFirst', chain: 'base', symbol: 'F' }]),
      walletsRepo,
      systemSvc,
    );
    await p1.process(makeJob('j1'));

    const p2 = buildProcessor(
      makeAdapter([{ address: '0xSecond', chain: 'base', symbol: 'S' }]),
      walletsRepo,
      systemSvc,
    );
    await p2.process(makeJob('j2'));

    const addresses = (await prisma.trackedWallet.findMany({})).map((r) => r.address);
    expect(addresses).toContain('0xFirst');
    expect(addresses).toContain('0xSecond');
    expect(await prisma.trackedWallet.count()).toBe(2);
  });
});
