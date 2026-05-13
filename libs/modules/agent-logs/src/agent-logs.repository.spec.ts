/**
 * Unit tests for AgentLogsRepository (SPEC §14, DoD §A).
 *
 * PrismaService is mocked to avoid any database connection.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AgentLogsRepository } from './agent-logs.repository.js';
import type { PrismaService } from '@cclaw/prisma';

// ---------------------------------------------------------------------------
// Sample rows (camelCase — Prisma model shape)
// ---------------------------------------------------------------------------

const researchRow = {
  id: 1,
  checkType: 'token_scan',
  tokensScanned: 10,
  tokensAnalyzed: 5,
  tradesProposed: 1,
  alertsProcessed: 2,
  watchlistHits: 0,
  summary: null,
  status: 'ok',
  createdAt: '2026-05-13 10:00:00',
};

const sentinelRow = {
  id: 2,
  checkType: 'price_check',
  positionsChecked: 3,
  alertsGenerated: 1,
  sellsExecuted: 0,
  status: 'ok',
  summary: null,
  createdAt: '2026-05-13 10:01:00',
};

const executorRow = {
  id: 3,
  sellOrdersProcessed: 2,
  buyOrdersProcessed: 1,
  pendingChecked: 0,
  successCount: 3,
  failCount: 0,
  queuedCount: 0,
  status: 'ok',
  summary: null,
  createdAt: '2026-05-13 10:02:00',
};

const observerRow = {
  id: 4,
  errorsAnalyzed: 1,
  issuesCreated: 0,
  alertsSent: 1,
  summary: 'all good',
  status: 'ok',
  createdAt: '2026-05-13 10:03:00',
};

function makePrisma(): PrismaService {
  return {
    researchLog: {
      create: vi.fn().mockResolvedValue(researchRow),
      findUnique: vi.fn().mockResolvedValue(researchRow),
      findMany: vi.fn().mockResolvedValue([researchRow]),
    },
    sentinelLog: {
      create: vi.fn().mockResolvedValue(sentinelRow),
      findUnique: vi.fn().mockResolvedValue(sentinelRow),
      findMany: vi.fn().mockResolvedValue([sentinelRow]),
    },
    executorLog: {
      create: vi.fn().mockResolvedValue(executorRow),
      findUnique: vi.fn().mockResolvedValue(executorRow),
      findMany: vi.fn().mockResolvedValue([executorRow]),
    },
    observerLog: {
      create: vi.fn().mockResolvedValue(observerRow),
      findUnique: vi.fn().mockResolvedValue(observerRow),
      findMany: vi.fn().mockResolvedValue([observerRow]),
    },
  } as unknown as PrismaService;
}

// ---------------------------------------------------------------------------
// Research
// ---------------------------------------------------------------------------

describe('AgentLogsRepository — research', () => {
  let repo: AgentLogsRepository;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AgentLogsRepository(prisma as unknown as PrismaService);
  });

  it('appendResearch maps snake_case response correctly', async () => {
    const result = await repo.appendResearch({ check_type: 'token_scan' });
    expect(result.id).toBe(1);
    expect(result.check_type).toBe('token_scan');
    expect(result.tokens_scanned).toBe(10);
    expect(result.created_at).toBe('2026-05-13 10:00:00');
  });

  it('appendResearch omits createdAt from create data', async () => {
    await repo.appendResearch({ check_type: 'token_scan' });
    const call = (prisma.researchLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('appendResearch uses dto defaults (0 for counts)', async () => {
    await repo.appendResearch({ check_type: 'token_scan' });
    const call = (prisma.researchLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.tokensScanned).toBe(0);
    expect(call.data.status).toBe('ok');
  });

  it('findResearchById returns mapped row', async () => {
    const result = await repo.findResearchById(1);
    expect(result.id).toBe(1);
    expect(result.check_type).toBe('token_scan');
  });

  it('findResearchById throws NotFoundException when row missing', async () => {
    (prisma.researchLog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(repo.findResearchById(999)).rejects.toThrow(NotFoundException);
  });

  it('findRecentResearch returns array with default limit 50', async () => {
    const result = await repo.findRecentResearch({});
    expect(Array.isArray(result)).toBe(true);
    const call = (prisma.researchLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it('findRecentResearch passes status filter', async () => {
    await repo.findRecentResearch({ status: 'error' });
    const call = (prisma.researchLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe('error');
  });

  it('findRecentResearch caps limit at 500', async () => {
    await repo.findRecentResearch({ limit: 999 });
    const call = (prisma.researchLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.take).toBe(500);
  });

  it('findRecentResearch passes since filter', async () => {
    await repo.findRecentResearch({ since: '2026-05-13 00:00:00' });
    const call = (prisma.researchLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: '2026-05-13 00:00:00' });
  });

  it('appendResearch maps null summary from Prisma row', async () => {
    const result = await repo.appendResearch({ check_type: 'token_scan' });
    // The mock row has summary: null; the mapper should pass it through as null
    expect(result.summary).toBeNull();
  });

  it('appendResearch maps null created_at from Prisma row', async () => {
    // Simulate SQLite-supplied createdAt arriving as null (edge case for nullable column)
    (prisma.researchLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...researchRow,
      createdAt: null,
    });
    const result = await repo.appendResearch({ check_type: 'token_scan' });
    expect(result.created_at).toBeNull();
  });

  it('findResearchById passes correct id to prisma.findUnique', async () => {
    await repo.findResearchById(42);
    const call = (prisma.researchLog.findUnique as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where).toEqual({ id: 42 });
  });

  // SQL injection safety — check_type stored as plain string, not executed
  it('appendResearch stores check_type containing SQL-injection payload as plain string', async () => {
    const injectionPayload = "'; DROP TABLE research_log; --";
    (prisma.researchLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...researchRow,
      checkType: injectionPayload,
    });
    const result = await repo.appendResearch({ check_type: injectionPayload });
    // The value is passed into the Prisma create call verbatim — Prisma handles parameterisation
    const call = (prisma.researchLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.checkType).toBe(injectionPayload);
    // The response mapper returns it unchanged
    expect(result.check_type).toBe(injectionPayload);
  });
});

// ---------------------------------------------------------------------------
// Sentinel
// ---------------------------------------------------------------------------

describe('AgentLogsRepository — sentinel', () => {
  let repo: AgentLogsRepository;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AgentLogsRepository(prisma as unknown as PrismaService);
  });

  it('appendSentinel maps response and omits createdAt', async () => {
    const result = await repo.appendSentinel({ check_type: 'price_check' });
    expect(result.id).toBe(2);
    expect(result.check_type).toBe('price_check');
    expect(result.positions_checked).toBe(3);
    const call = (prisma.sentinelLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('findSentinelById returns mapped row for existing id', async () => {
    const result = await repo.findSentinelById(2);
    expect(result.id).toBe(2);
    expect(result.check_type).toBe('price_check');
    expect(result.positions_checked).toBe(3);
    expect(result.alerts_generated).toBe(1);
    expect(result.sells_executed).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.summary).toBeNull();
    expect(result.created_at).toBe('2026-05-13 10:01:00');
  });

  it('findSentinelById throws NotFoundException for missing row', async () => {
    (prisma.sentinelLog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(repo.findSentinelById(999)).rejects.toThrow(NotFoundException);
  });

  it('findRecentSentinel passes since filter', async () => {
    await repo.findRecentSentinel({ since: '2026-05-13 00:00:00' });
    const call = (prisma.sentinelLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: '2026-05-13 00:00:00' });
  });

  it('findRecentSentinel passes status filter', async () => {
    await repo.findRecentSentinel({ status: 'warn' });
    const call = (prisma.sentinelLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe('warn');
  });

  it('findRecentSentinel applies default limit 50 when not specified', async () => {
    await repo.findRecentSentinel({});
    const call = (prisma.sentinelLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.take).toBe(50);
  });

  it('appendSentinel uses defaults for missing count fields', async () => {
    await repo.appendSentinel({ check_type: 'price_check' });
    const call = (prisma.sentinelLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.positionsChecked).toBe(0);
    expect(call.data.alertsGenerated).toBe(0);
    expect(call.data.sellsExecuted).toBe(0);
    expect(call.data.status).toBe('ok');
    expect(call.data.summary).toBeNull();
  });

  it('mapSentinel: non-null createdAt and non-null summary pass through unchanged', async () => {
    (prisma.sentinelLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...sentinelRow,
      summary: 'LP drop detected',
      createdAt: '2026-05-13 10:01:00',
    });
    const result = await repo.appendSentinel({ check_type: 'price_check' });
    expect(result.summary).toBe('LP drop detected');
    expect(result.created_at).toBe('2026-05-13 10:01:00');
  });

  it('mapSentinel: null createdAt maps to null', async () => {
    (prisma.sentinelLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...sentinelRow,
      summary: null,
      createdAt: null,
    });
    const result = await repo.appendSentinel({ check_type: 'price_check' });
    expect(result.summary).toBeNull();
    expect(result.created_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

describe('AgentLogsRepository — executor', () => {
  let repo: AgentLogsRepository;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AgentLogsRepository(prisma as unknown as PrismaService);
  });

  it('appendExecutor maps all count fields', async () => {
    const result = await repo.appendExecutor({
      sell_orders_processed: 2,
      buy_orders_processed: 1,
      success_count: 3,
    });
    expect(result.sell_orders_processed).toBe(2);
    expect(result.buy_orders_processed).toBe(1);
    expect(result.success_count).toBe(3);
    const call = (prisma.executorLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('findExecutorById returns mapped row for existing id', async () => {
    const result = await repo.findExecutorById(3);
    expect(result.id).toBe(3);
    expect(result.sell_orders_processed).toBe(2);
    expect(result.buy_orders_processed).toBe(1);
    expect(result.pending_checked).toBe(0);
    expect(result.success_count).toBe(3);
    expect(result.fail_count).toBe(0);
    expect(result.queued_count).toBe(0);
    expect(result.status).toBe('ok');
    expect(result.summary).toBeNull();
    expect(result.created_at).toBe('2026-05-13 10:02:00');
  });

  it('findExecutorById throws NotFoundException for missing row', async () => {
    (prisma.executorLog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(repo.findExecutorById(999)).rejects.toThrow(NotFoundException);
  });

  it('findRecentExecutor respects custom limit', async () => {
    await repo.findRecentExecutor({ limit: 10 });
    const call = (prisma.executorLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.take).toBe(10);
  });

  it('findRecentExecutor passes status filter', async () => {
    await repo.findRecentExecutor({ status: 'error' });
    const call = (prisma.executorLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe('error');
  });

  it('findRecentExecutor passes since filter', async () => {
    await repo.findRecentExecutor({ since: '2026-05-13 00:00:00' });
    const call = (prisma.executorLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: '2026-05-13 00:00:00' });
  });

  it('appendExecutor empty body uses all defaults', async () => {
    await repo.appendExecutor({});
    const call = (prisma.executorLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.sellOrdersProcessed).toBe(0);
    expect(call.data.buyOrdersProcessed).toBe(0);
    expect(call.data.pendingChecked).toBe(0);
    expect(call.data.successCount).toBe(0);
    expect(call.data.failCount).toBe(0);
    expect(call.data.queuedCount).toBe(0);
    expect(call.data.status).toBe('ok');
    expect(call.data.summary).toBeNull();
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('mapExecutor: non-null summary and createdAt pass through unchanged', async () => {
    (prisma.executorLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...executorRow,
      summary: 'nonce collision on tx 42',
      createdAt: '2026-05-13 10:02:00',
    });
    const result = await repo.appendExecutor({});
    expect(result.summary).toBe('nonce collision on tx 42');
    expect(result.created_at).toBe('2026-05-13 10:02:00');
  });

  it('mapExecutor: null summary and createdAt both map to null', async () => {
    (prisma.executorLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...executorRow,
      summary: null,
      createdAt: null,
    });
    const result = await repo.appendExecutor({});
    expect(result.summary).toBeNull();
    expect(result.created_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Observer
// ---------------------------------------------------------------------------

describe('AgentLogsRepository — observer', () => {
  let repo: AgentLogsRepository;
  let prisma: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    prisma = makePrisma();
    repo = new AgentLogsRepository(prisma as unknown as PrismaService);
  });

  it('appendObserver maps summary field', async () => {
    const result = await repo.appendObserver({ summary: 'all good' });
    expect(result.summary).toBe('all good');
    const call = (prisma.observerLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('findObserverById returns mapped row for existing id', async () => {
    const result = await repo.findObserverById(4);
    expect(result.id).toBe(4);
    expect(result.errors_analyzed).toBe(1);
    expect(result.issues_created).toBe(0);
    expect(result.alerts_sent).toBe(1);
    expect(result.summary).toBe('all good');
    expect(result.status).toBe('ok');
    expect(result.created_at).toBe('2026-05-13 10:03:00');
  });

  it('findObserverById throws NotFoundException for missing row', async () => {
    (prisma.observerLog.findUnique as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await expect(repo.findObserverById(999)).rejects.toThrow(NotFoundException);
  });

  it('findRecentObserver orders by createdAt desc', async () => {
    await repo.findRecentObserver({});
    const call = (prisma.observerLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.orderBy).toEqual({ createdAt: 'desc' });
  });

  it('findRecentObserver passes status filter', async () => {
    await repo.findRecentObserver({ status: 'ok' });
    const call = (prisma.observerLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.status).toBe('ok');
  });

  it('findRecentObserver passes since filter', async () => {
    await repo.findRecentObserver({ since: '2026-05-13 00:00:00' });
    const call = (prisma.observerLog.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.where.createdAt).toEqual({ gte: '2026-05-13 00:00:00' });
  });

  it('appendObserver uses defaults for missing count fields', async () => {
    await repo.appendObserver({});
    const call = (prisma.observerLog.create as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(call.data.errorsAnalyzed).toBe(0);
    expect(call.data.issuesCreated).toBe(0);
    expect(call.data.alertsSent).toBe(0);
    expect(call.data.status).toBe('ok');
    expect(call.data.summary).toBeNull();
    expect(call.data).not.toHaveProperty('createdAt');
  });

  it('mapObserver: non-null summary and createdAt pass through unchanged', async () => {
    (prisma.observerLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...observerRow,
      summary: 'observer healthy',
      createdAt: '2026-05-13 10:03:00',
    });
    const result = await repo.appendObserver({});
    expect(result.summary).toBe('observer healthy');
    expect(result.created_at).toBe('2026-05-13 10:03:00');
  });

  it('mapObserver: null summary and createdAt both map to null', async () => {
    (prisma.observerLog.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ...observerRow,
      summary: null,
      createdAt: null,
    });
    const result = await repo.appendObserver({});
    expect(result.summary).toBeNull();
    expect(result.created_at).toBeNull();
  });
});
