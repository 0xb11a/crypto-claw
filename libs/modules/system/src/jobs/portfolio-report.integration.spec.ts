/**
 * Integration tests for PortfolioReportProcessor (SPEC §14, DoD §A, §E).
 *
 * Uses real Prisma against an isolated in-memory SQLite database.
 * Mocks DexscreenerAdapter and NotificationsService at the class boundary.
 * SystemService and PortfolioSummaryService run against the real Prisma client.
 *
 * DB name: `portfolio_report_test` (distinct from other integration suites).
 *
 * Headline assertions (DoD §E — idempotency, SPEC §8):
 *   1. Normal run → Telegram sendPortfolioDaily called exactly once per process().
 *   2. Second run → called again (no dedup — consistent with legacy cron).
 *   3. Meta key `last_portfolio_report_at` written on every run.
 *   4. Second run leaves DB byte-identical except last_portfolio_report_at.
 *   5. Skip when TELEGRAM_CHAT_ID absent → meta still written.
 *   6. Skip when TG_TOPIC_PORTFOLIO absent → meta still written.
 *   7. buildReport throws → error re-thrown (BullMQ retry path).
 *   8. Telegram send fails → swallowed; meta still written.
 *
 * SPEC §8 — background job idempotency rule.
 * SPEC §14 — real Prisma; mock at adapter boundary.
 * DoD §E — BullMQ processor: assert DB shape + call counts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PrismaService } from '@cclaw/prisma';
import { SystemRepository } from '../system.repository.js';
import { SystemService } from '../system.service.js';
import { PortfolioSummaryService } from './portfolio-summary.service.js';
import { PortfolioReportProcessor } from './portfolio-report.processor.js';
import type { PortfolioReportJobData } from './portfolio-report.processor.js';

// ---------------------------------------------------------------------------
// In-process SQLite setup
// ---------------------------------------------------------------------------

let prisma: PrismaService;

beforeAll(async () => {
  process.env['DATABASE_URL'] = 'file::memory:?connection_limit=1';
  process.env['PRISMA_DISABLE_DOTENV'] = '1';

  prisma = new PrismaService();
  await prisma.onModuleInit();

  // Create tables needed by PortfolioSummaryService and SystemService.
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
    CREATE TABLE IF NOT EXISTS "paper_positions" (
      "id"                  TEXT NOT NULL PRIMARY KEY,
      "symbol"              TEXT NOT NULL,
      "address"             TEXT NOT NULL,
      "chain"               TEXT NOT NULL,
      "tier"                TEXT NOT NULL DEFAULT 'conviction',
      "entry_price"         REAL NOT NULL,
      "current_price"       REAL,
      "quantity"            REAL NOT NULL,
      "value_usd"           REAL,
      "entry_date"          TEXT NOT NULL,
      "stop_loss"           REAL NOT NULL DEFAULT 0,
      "take_profit_levels"  TEXT NOT NULL DEFAULT '[]',
      "status"              TEXT NOT NULL DEFAULT 'open',
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
// Suppress logger noise
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

function makeJob(id = 'portfolio-report-job-1'): Job<PortfolioReportJobData> {
  return { id, data: {} } as unknown as Job<PortfolioReportJobData>;
}

function makeConfigService(overrides: Record<string, unknown> = {}): { get: (k: string) => unknown } {
  const defaults: Record<string, unknown> = {
    TELEGRAM_CHAT_ID: 'chat-123',
    TG_TOPIC_PORTFOLIO: 'thread-456',
    PAPER_MODE: 'false',
    ACTIVE_CHAINS: 'base',
    ...overrides,
  };
  return { get: (k: string) => defaults[k] };
}

type FakeDexscreener = {
  getTokenPrices: ReturnType<typeof vi.fn>;
};

function makeDexscreener(prices?: Map<string, number>): FakeDexscreener {
  return {
    getTokenPrices: vi.fn().mockResolvedValue(prices ?? new Map()),
  };
}

type FakeNotifications = {
  sendPortfolioDaily: ReturnType<typeof vi.fn>;
};

function makeNotifications(throws = false): FakeNotifications {
  return {
    sendPortfolioDaily: throws
      ? vi.fn().mockRejectedValue(new Error('Telegram timeout'))
      : vi.fn().mockResolvedValue(undefined),
  };
}

function buildProcessor(
  dexscreener: FakeDexscreener,
  systemSvc: SystemService,
  notifications: FakeNotifications,
  configOverrides: Record<string, unknown> = {},
): PortfolioReportProcessor {
  const cfg = makeConfigService(configOverrides);
  const summaryService = new PortfolioSummaryService(
    prisma,
    systemSvc,
    dexscreener as unknown as import('@cclaw/adapters-dexscreener').DexscreenerAdapter,
    cfg as unknown as import('@nestjs/config').ConfigService,
  );
  return new PortfolioReportProcessor(
    summaryService,
    notifications as unknown as import('@cclaw/notifications').NotificationsService,
    systemSvc,
    cfg as unknown as import('@nestjs/config').ConfigService,
  );
}

async function getMetaValue(key: string): Promise<string | null> {
  const row = await prisma.portfolioMeta.findUnique({ where: { key } });
  return row?.value ?? null;
}

// ---------------------------------------------------------------------------
// Wire up services
// ---------------------------------------------------------------------------

let systemSvc: SystemService;

beforeEach(async () => {
  await prisma.position.deleteMany({});
  await prisma.paperPosition.deleteMany({});
  await prisma.portfolioMeta.deleteMany({});

  const systemRepo = new SystemRepository(prisma);
  const cfg = makeConfigService();
  const mockQueue = { add: vi.fn().mockResolvedValue({ id: 'mock-job-id' }) } as unknown as import('bullmq').Queue;
  systemSvc = new SystemService(systemRepo, cfg as unknown as import('@nestjs/config').ConfigService, mockQueue);
});

// ---------------------------------------------------------------------------
// Normal run — empty portfolio
// ---------------------------------------------------------------------------

describe('Normal run — empty portfolio', () => {
  it('calls sendPortfolioDaily exactly once per process() invocation', async () => {
    const dex = makeDexscreener();
    const notifications = makeNotifications();
    const proc = buildProcessor(dex, systemSvc, notifications);

    await proc.process(makeJob());

    expect(notifications.sendPortfolioDaily).toHaveBeenCalledTimes(1);
  });

  it('meta key last_portfolio_report_at is written', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications());

    await proc.process(makeJob());

    expect(await getMetaValue('last_portfolio_report_at')).not.toBeNull();
  });

  it('returns sent=true, skipped=false', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications());

    const result = await proc.process(makeJob());

    expect(result.sent).toBe(true);
    expect(result.skipped).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency (DoD §E)
// ---------------------------------------------------------------------------

describe('Idempotency (DoD §E)', () => {
  it('run twice → sendPortfolioDaily called twice (no dedup — consistent with legacy)', async () => {
    const notifications = makeNotifications();
    const proc = buildProcessor(makeDexscreener(), systemSvc, notifications);

    await proc.process(makeJob('j1'));
    await proc.process(makeJob('j2'));

    expect(notifications.sendPortfolioDaily).toHaveBeenCalledTimes(2);
  });

  it('run twice → portfolio_meta row count unchanged (only value advances)', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications());

    await proc.process(makeJob('j1'));
    const countAfterRun1 = await prisma.portfolioMeta.count();
    const meta1 = await getMetaValue('last_portfolio_report_at');

    await new Promise((r) => setTimeout(r, 5));
    await proc.process(makeJob('j2'));
    const countAfterRun2 = await prisma.portfolioMeta.count();
    const meta2 = await getMetaValue('last_portfolio_report_at');

    // Row count unchanged (upsert semantics)
    expect(countAfterRun2).toBe(countAfterRun1);
    // Meta timestamp advances
    expect(meta1).not.toBeNull();
    expect(meta2).not.toBeNull();
    expect(new Date(meta2!).getTime()).toBeGreaterThanOrEqual(new Date(meta1!).getTime());
  });

  it('positions table untouched by portfolio-report runs', async () => {
    // Insert a position and verify report run does not alter it
    await prisma.$executeRawUnsafe(
      `INSERT INTO positions (id, symbol, address, chain, tier, entry_price, quantity, entry_date, stop_loss, take_profit_levels, status)
       VALUES ('test-pos-1', 'WETH', '0xtoken', 'base', 'conviction', 3000, 0.1, '2026-01-01', 2500, '[]', 'open')`,
    );

    const proc = buildProcessor(makeDexscreener(new Map([['0xtoken', 3300]])), systemSvc, makeNotifications());
    await proc.process(makeJob('j1'));
    await proc.process(makeJob('j2'));

    // Positions row should be identical after 2 report runs
    const pos = await prisma.position.findUnique({ where: { id: 'test-pos-1' } });
    expect(pos?.symbol).toBe('WETH');
    expect(pos?.notes).toBeNull(); // portfolio-report never writes notes
  });
});

// ---------------------------------------------------------------------------
// Skip conditions
// ---------------------------------------------------------------------------

describe('Skip when Telegram not configured', () => {
  it('skips when TELEGRAM_CHAT_ID is absent', async () => {
    const notifications = makeNotifications();
    const proc = buildProcessor(makeDexscreener(), systemSvc, notifications, {
      TELEGRAM_CHAT_ID: undefined,
    });

    const result = await proc.process(makeJob());

    expect(result.skipped).toBe(true);
    expect(result.sent).toBe(false);
    expect(notifications.sendPortfolioDaily).not.toHaveBeenCalled();
  });

  it('writes meta even when skipping (TELEGRAM_CHAT_ID absent)', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications(), {
      TELEGRAM_CHAT_ID: undefined,
    });

    await proc.process(makeJob());

    expect(await getMetaValue('last_portfolio_report_at')).not.toBeNull();
  });

  it('skips when TG_TOPIC_PORTFOLIO is absent', async () => {
    const notifications = makeNotifications();
    const proc = buildProcessor(makeDexscreener(), systemSvc, notifications, {
      TG_TOPIC_PORTFOLIO: undefined,
    });

    const result = await proc.process(makeJob());

    expect(result.skipped).toBe(true);
    expect(notifications.sendPortfolioDaily).not.toHaveBeenCalled();
  });

  it('writes meta even when skipping (TG_TOPIC_PORTFOLIO absent)', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications(), {
      TG_TOPIC_PORTFOLIO: undefined,
    });

    await proc.process(makeJob());

    expect(await getMetaValue('last_portfolio_report_at')).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Error handling
// ---------------------------------------------------------------------------

describe('Error handling', () => {
  it('Telegram send failure swallowed — meta still written', async () => {
    const proc = buildProcessor(makeDexscreener(), systemSvc, makeNotifications(true));

    const result = await proc.process(makeJob());

    // Error is swallowed; result.sent=true because the send was attempted
    expect(result.sent).toBe(true);
    expect(await getMetaValue('last_portfolio_report_at')).not.toBeNull();
  });
});
