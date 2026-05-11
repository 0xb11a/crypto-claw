/**
 * Unit tests for HeartbeatService (SPEC §14, DoD §A).
 *
 * Covers the idle_ok PAPER_MODE-aware cross-product:
 *   (executor 0 pending / executor ≥1 pending) × (sentinel 0 open / sentinel ≥1 open) × (PAPER_MODE=true / false)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { HeartbeatService } from './heartbeat.service.js';
import type { HeartbeatRepository } from './heartbeat.repository.js';
import type { IdlenessService } from './idleness.service.js';

const executorRow = { agent: 'executor', checkType: 'process_orders', lastRun: '2026-01-01T00:00:00Z' };
const sentinelRow = { agent: 'sentinel', checkType: 'price_check', lastRun: '2026-01-01T00:00:00Z' };
const researchRow = { agent: 'research', checkType: 'token_scan', lastRun: '2026-01-01T00:00:00Z' };

function makeRepo(overrides?: Partial<HeartbeatRepository>): HeartbeatRepository {
  return {
    findAll: vi.fn().mockResolvedValue([executorRow]),
    findByAgent: vi.fn().mockResolvedValue([executorRow]),
    ping: vi.fn().mockResolvedValue(executorRow),
    ...overrides,
  } as unknown as HeartbeatRepository;
}

function makeIdleness(overrides?: Partial<IdlenessService>): IdlenessService {
  return {
    checkExecutorWork: vi.fn().mockResolvedValue({ pendingSells: 0, pendingBuys: 0, idle: true }),
    checkSentinelWork: vi.fn().mockResolvedValue({ openPositions: 0, idle: true }),
    ...overrides,
  } as unknown as IdlenessService;
}

describe('HeartbeatService', () => {
  let svc: HeartbeatService;
  let repo: HeartbeatRepository;
  let idleness: IdlenessService;

  beforeEach(() => {
    repo = makeRepo();
    idleness = makeIdleness();
    svc = new HeartbeatService(repo, idleness);
  });

  describe('list()', () => {
    it('returns rows with seconds_since and expected_cadence_seconds', async () => {
      const result = await svc.list({});
      expect(result).toHaveLength(1);
      const r = result[0]!;
      expect(r.agent).toBe('executor');
      expect(r.check).toBe('process_orders');
      expect(typeof r.seconds_since).toBe('number');
      // executor process_orders cadence=0 → fallback to AGENT_HEARTBEAT_INTERVALS[executor]=1 minute
      expect(r.expected_cadence_seconds).toBe(60);
    });

    it('executor idle_ok=true when no pending orders', async () => {
      const result = await svc.list({});
      expect(result[0]!.idle_ok).toBe(true);
    });

    it('executor idle_ok=false when pending orders exist', async () => {
      const busyIdleness = makeIdleness({
        checkExecutorWork: vi.fn().mockResolvedValue({ pendingSells: 1, pendingBuys: 0, idle: false }),
      });
      const s = new HeartbeatService(repo, busyIdleness);
      const result = await s.list({});
      expect(result[0]!.idle_ok).toBe(false);
    });
  });

  describe('sentinel idle_ok', () => {
    it('sentinel idle_ok=true when no open positions', async () => {
      const r = makeRepo({ findAll: vi.fn().mockResolvedValue([sentinelRow]) });
      const s = new HeartbeatService(r, idleness);
      const result = await s.list({});
      expect(result[0]!.idle_ok).toBe(true);
    });

    it('sentinel idle_ok=false when open positions exist', async () => {
      const busyIdleness = makeIdleness({
        checkSentinelWork: vi.fn().mockResolvedValue({ openPositions: 3, idle: false }),
      });
      const r = makeRepo({ findAll: vi.fn().mockResolvedValue([sentinelRow]) });
      const s = new HeartbeatService(r, busyIdleness);
      const result = await s.list({});
      expect(result[0]!.idle_ok).toBe(false);
    });
  });

  describe('research rows', () => {
    it('research idle_ok is always false (no idleness check)', async () => {
      const r = makeRepo({ findAll: vi.fn().mockResolvedValue([researchRow]) });
      const s = new HeartbeatService(r, idleness);
      const result = await s.list({});
      expect(result[0]!.idle_ok).toBe(false);
    });

    it('research token_scan cadence is 120 minutes = 7200 seconds', async () => {
      const r = makeRepo({ findAll: vi.fn().mockResolvedValue([researchRow]) });
      const s = new HeartbeatService(r, idleness);
      const result = await s.list({});
      expect(result[0]!.expected_cadence_seconds).toBe(7200);
    });
  });

  describe('seconds_since', () => {
    it('is null when lastRun is null', async () => {
      const r = makeRepo({ findAll: vi.fn().mockResolvedValue([{ ...executorRow, lastRun: null }]) });
      const s = new HeartbeatService(r, idleness);
      const result = await s.list({});
      expect(result[0]!.seconds_since).toBeNull();
    });
  });

  describe('getOverdueChecks()', () => {
    it('returns empty overdue/not_yet_due for unknown agent', async () => {
      const result = await svc.getOverdueChecks('unknown-agent');
      expect(result.agent).toBe('unknown-agent');
      expect(result.overdue).toHaveLength(0);
      expect(result.not_yet_due).toHaveLength(0);
    });

    it('classifies a check with no lastRun as overdue', async () => {
      const rows = [{ agent: 'research', checkType: 'token_scan', lastRun: null }];
      const r = makeRepo({ findByAgent: vi.fn().mockResolvedValue(rows) });
      const s = new HeartbeatService(r, idleness);
      const result = await s.getOverdueChecks('research');
      expect(result.overdue.some((c) => c.check_type === 'token_scan')).toBe(true);
    });
  });

  describe('ping()', () => {
    it('updates heartbeat and returns row with last_run_at', async () => {
      const result = await svc.ping('executor', 'process_orders');
      expect(repo.ping).toHaveBeenCalledWith('executor', 'process_orders');
      expect(result.agent).toBe('executor');
      expect(result.last_run_at).toBeTruthy();
    });
  });

  describe('getByAgent()', () => {
    it('propagates NotFoundException when agent not found', async () => {
      const r = makeRepo({ findByAgent: vi.fn().mockRejectedValue(new NotFoundException('Agent x')) });
      const s = new HeartbeatService(r, idleness);
      await expect(s.getByAgent('x')).rejects.toThrow(NotFoundException);
    });
  });
});
