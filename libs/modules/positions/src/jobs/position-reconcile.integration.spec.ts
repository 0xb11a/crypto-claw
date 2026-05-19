/**
 * Integration tests for PositionReconcileProcessor (SPEC §14, DoD §A, §E).
 *
 * Uses real Prisma against an isolated in-memory SQLite database.
 * Mocks OnchainBalanceAdapter, NotificationsService at the class boundary.
 * PositionsRepository and SystemService run against the real Prisma client.
 *
 * DB name: `position_reconcile_test` (distinct from other integration suites).
 *
 * Headline assertions (DoD §E — idempotency, SPEC §8):
 *   1. Triple-run idempotency: run process() 3 times with adapter returning
 *      the same on-chain state → positions row count unchanged, notes
 *      appended ONCE only (dedup marker), meta key written.
 *   2. No drift detected → notes field untouched, no alert sent.
 *   3. Drift detected on first run → note appended once with marker.
 *   4. Second run same drift → dedup guard prevents duplicate note.
 *   5. Third run same drift → still only one marker.
 *   6. Meta key `last_position_reconcile_at` written on every run.
 *   7. PAPER_MODE=true → no positions loaded, meta still written.
 *   8. Vault address absent → errorCount > 0, positions row unchanged.
 *
 * SPEC §8 — background job idempotency rule.
 * SPEC §14 — real Prisma; mock at adapter boundary.
 * DoD §E — BullMQ processor: run twice, assert DB shape unchanged after second run.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '@cclaw/prisma';
import { PositionsRepository } from '../positions.repository.js';
import { PositionsService } from '../positions.service.js';
import { SystemRepository } from '@cclaw/system';
import { SystemService } from '@cclaw/system';
import { PositionReconcileProcessor } from './position-reconcile.processor.js';
import type { PositionReconcileJobData } from './position-reconcile.processor.js';

// ---------------------------------------------------------------------------
// In-process SQLite setup
// ---------------------------------------------------------------------------

let prisma: PrismaService;

beforeAll(async () => {
  // Named in-memory SQLite per suite — anonymous file::memory: shares a
  // better-sqlite3 handle across spec files landing in the same vitest
  // worker thread (V8 isolation doesn't invalidate native module state),
  // contaminating sibling specs (e.g. portfolio-report). The named
  // file:<name>?mode=memory&cache=shared URL gives each spec its own DB.
  process.env['DATABASE_URL'] = 'file::position_reconcile_test?mode=memory&cache=shared&connection_limit=1';
  process.env['PRISMA_DISABLE_DOTENV'] = '1';

  prisma = new PrismaService();
  await prisma.onModuleInit();

  // Create tables used by this processor.
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "positions" (
      "id"                  TEXT NOT NULL PRIMARY KEY,
      "symbol"              TEXT NOT NULL,
      "name"                TEXT,
      "address"             TEXT NOT NULL,
      "chain"               TEXT NOT NULL,
      "tier"                TEXT NOT NULL DEFAULT 'conviction',
      "entry_price"         REAL NOT NULL,
      "current_price"       REAL,
      "quantity"            REAL NOT NULL,
      "value_usd"           REAL,
      "percent_of_portfolio" REAL,
      "entry_date"          TEXT NOT NULL,
      "stop_loss"           REAL NOT NULL DEFAULT 0,
      "take_profit_levels"  TEXT NOT NULL DEFAULT '[]',
      "narrative"           TEXT,
      "status"              TEXT NOT NULL DEFAULT 'open',
      "notes"               TEXT,
      "onchain_balance"     REAL,
      "last_synced_at"      TEXT,
      "exit_price"          REAL,
      "exit_date"           TEXT,
      "pnl_percent"         REAL,
      "pnl_usd"             REAL,
      "exit_reason"         TEXT,
      "max_price_since_entry" REAL,
      "trailing_stop_pct"   REAL,
      "trailing_stop_active" INTEGER NOT NULL DEFAULT 0,
      "tp_levels_hit"       TEXT NOT NULL DEFAULT '[]',
      "created_at"          TEXT,
      "updated_at"          TEXT
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
// Suppress logger noise during tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(id = 'reconcile-job-1'): Job<PositionReconcileJobData> {
  return { id, data: {} } as unknown as Job<PositionReconcileJobData>;
}

function makeConfigService(overrides: Record<string, unknown> = {}): { get: (k: string) => unknown } {
  const defaults: Record<string, unknown> = {
    PAPER_MODE: 'false',
    SAFE_ADDRESS_BASE: '0xsafe',
    RPC_VALIDATION_MODE: 'skip',
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

type FakeOnchainAdapter = {
  getTokenDecimals: (chain: string, token: string) => Promise<number>;
  getTokenBalance: (chain: string, token: string, owner: string, decimals: number) => Promise<number>;
};

function makeOnchainAdapter(decimals: number | Error = 18, balance: number | Error = 100): FakeOnchainAdapter {
  return {
    getTokenDecimals: async () => {
      if (decimals instanceof Error) throw decimals;
      return decimals;
    },
    getTokenBalance: async () => {
      if (balance instanceof Error) throw balance;
      return balance;
    },
  };
}

type FakeNotifications = { sendRugWarning: ReturnType<typeof vi.fn> };

function makeNotifications(): FakeNotifications {
  return { sendRugWarning: vi.fn().mockResolvedValue(undefined) };
}

function buildProcessor(
  onchainAdapter: FakeOnchainAdapter,
  positionsSvc: PositionsService,
  systemSvc: SystemService,
  notifications: FakeNotifications,
  configOverrides: Record<string, unknown> = {},
): PositionReconcileProcessor {
  const cfg = makeConfigService(configOverrides);
  return new PositionReconcileProcessor(
    positionsSvc,
    onchainAdapter as unknown as import('@cclaw/adapters-onchain-balance').OnchainBalanceAdapter,
    notifications as unknown as import('@cclaw/notifications').NotificationsService,
    systemSvc,
    cfg as unknown as import('@nestjs/config').ConfigService,
  );
}

async function insertPosition(opts: {
  id?: string;
  symbol?: string;
  address?: string;
  chain?: string;
  quantity?: number;
  status?: string;
  notes?: string | null;
}): Promise<void> {
  const id = opts.id ?? `pos-${Date.now()}`;
  await prisma.$executeRawUnsafe(
    `INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, entry_date, stop_loss, take_profit_levels, status, notes, created_at)
     VALUES (?, ?, ?, ?, 'conviction', 1000, ?, '2026-01-01', 900, '[]', ?, ?, ?)`,
    id,
    opts.symbol ?? 'WETH',
    opts.address ?? '0xtoken',
    opts.chain ?? 'base',
    opts.quantity ?? 100,
    opts.status ?? 'open',
    opts.notes ?? null,
    new Date().toISOString(),
  );
}

async function getPositionNotes(id: string): Promise<string | null> {
  const row = await prisma.position.findUnique({ where: { id }, select: { notes: true } });
  return row?.notes ?? null;
}

async function getMetaValue(key: string): Promise<string | null> {
  const row = await prisma.portfolioMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

async function countDriftMarkers(notes: string | null): Promise<number> {
  if (!notes) return 0;
  return (notes.match(/recon_drift_/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// Wire up repos and services
// ---------------------------------------------------------------------------

let positionsRepo: PositionsRepository;
let positionsSvc: PositionsService;
let systemSvc: SystemService;

beforeEach(async () => {
  // Isolate each test case
  await prisma.position.deleteMany({});
  await prisma.portfolioMeta.deleteMany({});

  positionsRepo = new PositionsRepository(prisma);
  positionsSvc = new PositionsService(positionsRepo);
  const systemRepo = new SystemRepository(prisma);
  const cfg = makeConfigService();
  const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }) } as unknown as import('bullmq').Queue;
  systemSvc = new SystemService(systemRepo, cfg as unknown as import('@nestjs/config').ConfigService, mockQueue);
});

// ---------------------------------------------------------------------------
// No drift
// ---------------------------------------------------------------------------

describe('No drift — notes unchanged', () => {
  it('notes remain null when on-chain matches DB quantity exactly', async () => {
    await insertPosition({ id: 'pos-1', quantity: 100 });
    const adapter = makeOnchainAdapter(18, 100); // exact match
    const notifications = makeNotifications();
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, notifications);

    await proc.process(makeJob());

    const notes = await getPositionNotes('pos-1');
    expect(notes).toBeNull();
    expect(notifications.sendRugWarning).not.toHaveBeenCalled();
  });

  it('notes remain null when drift is within 1% threshold', async () => {
    await insertPosition({ id: 'pos-1', quantity: 100 });
    const adapter = makeOnchainAdapter(18, 100.5); // 0.5% drift — within threshold
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, makeNotifications());

    await proc.process(makeJob());

    expect(await getPositionNotes('pos-1')).toBeNull();
  });

  it('meta key always written even when no drift detected', async () => {
    await insertPosition({ id: 'pos-1', quantity: 100 });
    const proc = buildProcessor(makeOnchainAdapter(18, 100), positionsSvc, systemSvc, makeNotifications());

    await proc.process(makeJob());

    const meta = await getMetaValue('last_position_reconcile_at');
    expect(meta).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Drift detected — first run appends note
// ---------------------------------------------------------------------------

describe('Drift detected', () => {
  it('appends drift marker on first run when drift > 1%', async () => {
    await insertPosition({ id: 'pos-drift-1', quantity: 100, notes: null });
    // 90 on-chain = 10% drift
    const adapter = makeOnchainAdapter(18, 90);
    const notifications = makeNotifications();
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, notifications);

    const result = await proc.process(makeJob());

    expect(result.driftCount).toBe(1);
    const notes = await getPositionNotes('pos-drift-1');
    expect(notes).not.toBeNull();
    expect(notes).toContain('recon_drift_');
    expect(notes).toContain('direction=short');
  });

  it('sendRugWarning called exactly once per run when drift detected', async () => {
    await insertPosition({ id: 'pos-drift-2', quantity: 100, notes: null });
    const notifications = makeNotifications();
    const proc = buildProcessor(makeOnchainAdapter(18, 85), positionsSvc, systemSvc, notifications);

    await proc.process(makeJob());

    expect(notifications.sendRugWarning).toHaveBeenCalledOnce();
  });

  it('multiple drifted positions → driftCount reflects correct count', async () => {
    await insertPosition({ id: 'pos-a', quantity: 100, notes: null });
    await insertPosition({ id: 'pos-b', quantity: 200, address: '0xtoken2', notes: null });
    const adapter = makeOnchainAdapter(18, 50); // both drift heavily
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, makeNotifications());

    const result = await proc.process(makeJob());

    expect(result.driftCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Idempotency — triple-run (DoD §E headline)
// ---------------------------------------------------------------------------

describe('Idempotency (DoD §E — triple-run)', () => {
  it('notes appended ONCE only on 3 consecutive runs with same drift (dedup guard)', async () => {
    // Strategy: seed positions.notes with a drift marker that already contains
    // the current UTC hour so the dedup guard fires on runs 2 and 3.
    // This exercises the integration path without needing fake timers on Prisma I/O.

    // Pre-seed with a marker timestamped in the current UTC hour.
    const nowHour = new Date().toISOString().slice(0, 13); // 'YYYY-MM-DDTHH'
    const preSeededNotes = `[${nowHour}:00:00] recon_drift_10.00pct direction=short db=100 onchain=90`;

    await insertPosition({ id: 'pos-idem', quantity: 100, notes: preSeededNotes });
    const adapter = makeOnchainAdapter(18, 90); // 10% drift — same as pre-seeded marker
    const notifications = makeNotifications();
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, notifications);

    // Run 1: dedup guard fires (marker already in same hour) → no append
    const result1 = await proc.process(makeJob('j1'));
    expect(result1.driftCount).toBe(1); // drift IS detected...
    const countAfterRun1 = await countDriftMarkers(await getPositionNotes('pos-idem'));

    // Run 2: same state — still deduped
    const result2 = await proc.process(makeJob('j2'));
    expect(result2.driftCount).toBe(1);
    const countAfterRun2 = await countDriftMarkers(await getPositionNotes('pos-idem'));

    // Run 3: same state — still deduped
    const result3 = await proc.process(makeJob('j3'));
    expect(result3.driftCount).toBe(1);
    const countAfterRun3 = await countDriftMarkers(await getPositionNotes('pos-idem'));

    // Marker count should stay at 1 for all three runs (not appended again)
    expect(countAfterRun1).toBe(1); // pre-seeded, run 1 didn't append
    expect(countAfterRun2).toBe(1); // run 2 didn't append
    expect(countAfterRun3).toBe(1); // run 3 didn't append

    // Meta must be written every run
    expect(await getMetaValue('last_position_reconcile_at')).not.toBeNull();
  });

  it('first run with fresh notes appends marker; second run in same hour deduplicates', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-fresh', quantity: 100, notes: null });
    const adapter = makeOnchainAdapter(18, 90); // 10% drift
    const notifications = makeNotifications();
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, notifications);

    // Run 1: fresh position — drift marker should be appended
    const result1 = await proc.process(makeJob('fresh-j1'));
    expect(result1.driftCount).toBe(1);
    const countAfterRun1 = await countDriftMarkers(await getPositionNotes('pos-fresh'));
    expect(countAfterRun1).toBe(1);

    // Run 2 within the same second (same UTC hour) — dedup fires
    const result2 = await proc.process(makeJob('fresh-j2'));
    expect(result2.driftCount).toBe(1); // drift still detected
    const countAfterRun2 = await countDriftMarkers(await getPositionNotes('pos-fresh'));
    // Still only 1 marker — dedup prevented duplicate append
    expect(countAfterRun2).toBe(1);
  });

  it('meta key `last_position_reconcile_at` advances on every run', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-meta', quantity: 100, notes: null });
    const proc = buildProcessor(
      makeOnchainAdapter(18, 100), // no drift
      positionsSvc,
      systemSvc,
      makeNotifications(),
    );

    await proc.process(makeJob('j1'));
    const meta1 = await getMetaValue('last_position_reconcile_at');
    await new Promise((r) => setTimeout(r, 5));
    await proc.process(makeJob('j2'));
    const meta2 = await getMetaValue('last_position_reconcile_at');

    expect(meta1).not.toBeNull();
    expect(meta2).not.toBeNull();
    expect(new Date(meta2!).getTime()).toBeGreaterThanOrEqual(new Date(meta1!).getTime());
  });

  it('row count unchanged after second run (positions table stable)', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-count', quantity: 100, notes: null });
    const proc = buildProcessor(makeOnchainAdapter(18, 90), positionsSvc, systemSvc, makeNotifications());

    await proc.process(makeJob('j1'));
    const count1 = await prisma.position.count();
    await proc.process(makeJob('j2'));
    const count2 = await prisma.position.count();

    expect(count1).toBe(1);
    expect(count2).toBe(1); // same row count — no new rows created
  });
});

// ---------------------------------------------------------------------------
// PAPER_MODE skip
// ---------------------------------------------------------------------------

describe('PAPER_MODE=true skip', () => {
  it('does not load positions and returns skipped=true', async () => {
    await insertPosition({ id: 'pos-paper', quantity: 100, notes: null });
    const proc = buildProcessor(
      makeOnchainAdapter(18, 50), // would drift if run
      positionsSvc,
      systemSvc,
      makeNotifications(),
      { PAPER_MODE: 'true' },
    );

    const result = await proc.process(makeJob());

    expect(result.skipped).toBe(true);
    expect(result.totalPositions).toBe(0);
    // Notes must remain null — no reconcile happened
    expect(await getPositionNotes('pos-paper')).toBeNull();
  });

  it('still writes meta when PAPER_MODE=true', async () => {
    const proc = buildProcessor(makeOnchainAdapter(18, 100), positionsSvc, systemSvc, makeNotifications(), {
      PAPER_MODE: 'true',
    });

    await proc.process(makeJob());

    expect(await getMetaValue('last_position_reconcile_at')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Vault address not resolved
// ---------------------------------------------------------------------------

describe('Vault address not resolved', () => {
  it('counts error and does not modify position notes', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-novault', quantity: 100, notes: null, chain: 'base' });
    const proc = buildProcessor(
      makeOnchainAdapter(18, 90),
      positionsSvc,
      systemSvc,
      makeNotifications(),
      { SAFE_ADDRESS_BASE: undefined }, // no vault address configured
    );

    const result = await proc.process(makeJob());

    expect(result.errorCount).toBeGreaterThan(0);
    // notes untouched
    expect(await getPositionNotes('pos-novault')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error handling: decimals / balance fetch failure
// ---------------------------------------------------------------------------

describe('Error handling during per-position reconcile', () => {
  it('counts errorCount when decimals fetch fails, meta still written', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-err1', quantity: 100, notes: null });
    const adapter = makeOnchainAdapter(new Error('RPC down'), 100);
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, makeNotifications());

    // Use real timers — the processor has a 200ms delay after error; let it run naturally.
    const result = await proc.process(makeJob());

    expect(result.errorCount).toBe(1);
    expect(await getMetaValue('last_position_reconcile_at')).not.toBeNull();
  });

  it('counts errorCount when balance fetch fails, meta still written', async () => {
    vi.useRealTimers();
    await insertPosition({ id: 'pos-err2', quantity: 100, notes: null });
    const adapter = makeOnchainAdapter(18, new Error('getAccount failed'));
    const proc = buildProcessor(adapter, positionsSvc, systemSvc, makeNotifications());

    const result = await proc.process(makeJob());

    expect(result.errorCount).toBe(1);
    expect(await getMetaValue('last_position_reconcile_at')).not.toBeNull();
  });
});
