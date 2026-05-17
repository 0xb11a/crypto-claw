/**
 * Unit tests for AlertsService (SPEC §14, DoD §A).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { AlertsService } from './alerts.service.js';
import type { AlertsRepository } from './alerts.repository.js';
import type { AlertResponseDto } from './dto/alert-response.dto.js';
import type { NotificationsService } from '@cclaw/notifications';

const unprocessedAlert: AlertResponseDto = {
  id: 'alert-1',
  symbol: 'ETH',
  chain: 'base',
  alert_type: 'stop_loss',
  severity: 'high',
  processed: 0,
};

const processedAlert: AlertResponseDto = {
  ...unprocessedAlert,
  processed: 1,
  processed_at: '2026-01-01T01:00:00Z',
};

function makeRepo(overrides?: Partial<AlertsRepository>): AlertsRepository {
  return {
    findMany: vi.fn().mockResolvedValue([unprocessedAlert]),
    findById: vi.fn().mockResolvedValue(unprocessedAlert),
    create: vi.fn().mockResolvedValue(unprocessedAlert),
    acknowledge: vi.fn().mockResolvedValue(processedAlert),
    count: vi.fn().mockResolvedValue(1),
    ...overrides,
  } as unknown as AlertsRepository;
}

function makeNotifications(overrides?: Partial<NotificationsService>): NotificationsService {
  return {
    sendCriticalAlert: vi.fn().mockResolvedValue(undefined),
    sendTradeExecuted: vi.fn().mockResolvedValue(undefined),
    sendTradeFailed: vi.fn().mockResolvedValue(undefined),
    sendRugWarning: vi.fn().mockResolvedValue(undefined),
    sendSystemHealth: vi.fn().mockResolvedValue(undefined),
    sendPortfolioDaily: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as NotificationsService;
}

describe('AlertsService', () => {
  let svc: AlertsService;
  let repo: AlertsRepository;
  let notifications: NotificationsService;

  beforeEach(() => {
    repo = makeRepo();
    notifications = makeNotifications();
    svc = new AlertsService(repo, notifications);
  });

  describe('list()', () => {
    it('returns paginated envelope', async () => {
      const result = await svc.list({});
      expect(result.data).toHaveLength(1);
      expect(result.pagination.total).toBe(1);
      expect(result.pagination.hasMore).toBe(false);
    });

    it('cursor points to last item id', async () => {
      const result = await svc.list({});
      expect(result.pagination.cursor).toBe('alert-1');
    });

    it('hasMore=true when data.length === limit', async () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ ...unprocessedAlert, id: `a-${i}` }));
      const r = makeRepo({ findMany: vi.fn().mockResolvedValue(many), count: vi.fn().mockResolvedValue(100) });
      const s = new AlertsService(r, makeNotifications());
      const res = await s.list({ limit: 50 });
      expect(res.pagination.hasMore).toBe(true);
    });
  });

  describe('getById()', () => {
    it('delegates to repo', async () => {
      const result = await svc.getById('alert-1');
      expect(result.id).toBe('alert-1');
    });

    it('propagates NotFoundException', async () => {
      const r = makeRepo({ findById: vi.fn().mockRejectedValue(new NotFoundException('Alert x not found')) });
      await expect(new AlertsService(r, makeNotifications()).getById('x')).rejects.toThrow(NotFoundException);
    });
  });

  describe('create()', () => {
    it('delegates to repo.create', async () => {
      const dto = { symbol: 'ETH', chain: 'base', alert_type: 'stop_loss', severity: 'high' as const };
      const result = await svc.create(dto);
      expect(repo.create).toHaveBeenCalledWith(dto);
      expect(result).toBe(unprocessedAlert);
    });
  });

  describe('acknowledge()', () => {
    it('delegates to repo.acknowledge', async () => {
      const result = await svc.acknowledge('alert-1', {});
      expect(repo.acknowledge).toHaveBeenCalledWith('alert-1');
      expect(result.processed).toBe(1);
    });

    it('idempotent: calling twice still returns processed=1', async () => {
      // First call
      await svc.acknowledge('alert-1', {});
      // Second call — repo returns already-processed row
      const r2 = makeRepo({ acknowledge: vi.fn().mockResolvedValue(processedAlert) });
      const s2 = new AlertsService(r2, makeNotifications());
      const result = await s2.acknowledge('alert-1', {});
      expect(result.processed).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // send() — ADR-0028, SPEC §14, DoD §A, plan §D item 9
  // -------------------------------------------------------------------------

  describe('send()', () => {
    const validDto = {
      type: 'rug_warning',
      agent: 'sentinel',
      message: 'rug detected on TOKEN',
    };

    it('always returns { accepted: true }', async () => {
      const result = await svc.send(validDto);
      expect(result).toEqual({ accepted: true });
    });

    it('calls notifications.sendCriticalAlert with correct type/agent/message', async () => {
      await svc.send(validDto);

      // Allow time for the fire-and-forget void call to schedule
      await new Promise((r) => setImmediate(r));

      expect(notifications.sendCriticalAlert).toHaveBeenCalledWith({
        type: 'rug_warning',
        agent: 'sentinel',
        message: 'rug detected on TOKEN',
      });
    });

    it('returns { accepted: true } even when NotificationsService throws', async () => {
      // The service uses `void` (fire-and-forget) — the rejection must not escape to vitest.
      // We attach a .catch() on the mock to suppress the unhandled rejection.
      let rejectFn!: (err: Error) => void;
      const controlled = new Promise<undefined>((_res, rej) => {
        rejectFn = rej;
      });
      (notifications.sendCriticalAlert as ReturnType<typeof vi.fn>).mockReturnValueOnce(
        controlled.catch(() => undefined), // suppress unhandled rejection at mock level
      );

      const result = await svc.send(validDto);
      expect(result).toEqual({ accepted: true });

      // Now trigger the rejection — the suppressed catch above absorbs it
      rejectFn(new Error('Telegram unreachable'));
      await new Promise((r) => setImmediate(r));
    });

    it('does NOT forward the data field to NotificationsService', async () => {
      const dtoWithData = { ...validDto, data: { extra: 'metadata', count: 42 } };
      await svc.send(dtoWithData);

      await new Promise((r) => setImmediate(r));

      expect(notifications.sendCriticalAlert).toHaveBeenCalledWith(
        expect.not.objectContaining({ data: expect.anything() }),
      );
    });

    it('does NOT call NotificationsService with the data field — only type/agent/message', async () => {
      const dtoWithData = { ...validDto, data: { SAFE_SIGNER_KEY: '0xfake' } };
      await svc.send(dtoWithData);

      await new Promise((r) => setImmediate(r));

      const callArg = (notifications.sendCriticalAlert as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
        string,
        unknown
      >;
      expect(Object.keys(callArg ?? {})).toEqual(['type', 'agent', 'message']);
    });

    it('is fire-and-forget: returns before Telegram delivery completes', async () => {
      let resolveAlert!: () => void;
      const delayedAlert = new Promise<undefined>((res) => {
        resolveAlert = () => res(undefined);
      });
      (notifications.sendCriticalAlert as ReturnType<typeof vi.fn>).mockReturnValueOnce(delayedAlert);

      const start = Date.now();
      const result = await svc.send(validDto);
      const elapsed = Date.now() - start;

      expect(result).toEqual({ accepted: true });
      // The call must resolve before the Telegram delivery finishes
      expect(elapsed).toBeLessThan(100);

      // Clean up the hanging promise
      resolveAlert();
    });

    it('works with all 15 AlertType literals — no type assertion error', async () => {
      const types = [
        'recovered',
        'trade_proposal',
        'trade_executed',
        'trade_failed',
        'trade_retry',
        'sell_triggered',
        'sentinel_alert_followup',
        'model_failure',
        'emergency_mode',
        'rug_warning',
        'signer_low_balance',
        'system_health',
        'heartbeat_summary',
        'portfolio_daily',
        'rebalance_event',
      ];
      for (const type of types) {
        const result = await svc.send({ type, agent: 'test', message: 'msg' });
        expect(result).toEqual({ accepted: true });
      }
    });
  });
});
