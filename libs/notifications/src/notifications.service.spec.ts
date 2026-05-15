/**
 * Unit tests for NotificationsService (SPEC §14, DoD §A, §F).
 *
 * Mocks TelegramAdapter at the class boundary. Tests service logic in isolation.
 *
 * Covers:
 *   sendCriticalAlert:
 *     - TELEGRAM_CHAT_ID absent → silently drops (no adapter call).
 *     - TELEGRAM_BOT_TOKEN absent → TelegramBotTokenMissingError caught, silently dropped.
 *     - Happy path: telegram.sendMessage called with correct chatId/text/threadId.
 *     - Topic routing: type=rug_warning → threadId from TG_TOPIC_ALERTS.
 *     - Topic routing: type=system_health → threadId from TG_TOPIC_OBSERVER.
 *     - Message format: emoji prefix + [AGENT] + message + SEP + Fund footer.
 *     - SAFE_ID footer: "Fund: <safeId>" in message.
 *     - TelegramApiError in sendMessage → swallowed (alerting must not crash).
 *     - Generic error in sendMessage → swallowed.
 *
 *   sendTradeExecuted / sendTradeFailed / sendRugWarning / sendSystemHealth:
 *     - Delegate to sendCriticalAlert with correct type.
 *
 * SPEC §4 #6 — no process.env; all config via ConfigService.
 * DoD §A — tests fail before, pass after.
 * DoD §F — bot token never exposed (tested in telegram.adapter.spec.ts).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { TelegramAdapter } from './telegram.adapter.js';
import { TelegramBotTokenMissingError, TelegramApiError } from './telegram.adapter.js';
import { NotificationsService } from './notifications.service.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfigService(overrides: Record<string, string | undefined> = {}): ConfigService {
  const defaults: Record<string, string | undefined> = {
    TELEGRAM_CHAT_ID: '-1001234567890',
    SAFE_ID: 'test-fund',
    TG_TOPIC_ALERTS: '101',
    TG_TOPIC_OBSERVER: '102',
    TG_TOPIC_EXECUTOR: '103',
    TG_TOPIC_SENTINEL: '104',
    TG_TOPIC_RESEARCH: '105',
    TG_TOPIC_SYSTEM: '106',
    TG_TOPIC_PORTFOLIO: '107',
    ...overrides,
  };
  return {
    get: vi.fn((key: string) => defaults[key]),
  } as unknown as ConfigService;
}

function makeTelegramAdapter(): TelegramAdapter {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    editMessageText: vi.fn().mockResolvedValue(undefined),
    answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
    getUpdates: vi.fn().mockResolvedValue([]),
  } as unknown as TelegramAdapter;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NotificationsService', () => {
  let telegram: TelegramAdapter;
  let configService: ConfigService;
  let service: NotificationsService;

  beforeEach(() => {
    telegram = makeTelegramAdapter();
    configService = makeConfigService();
    service = new NotificationsService(telegram, configService);
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Silent drop: missing TELEGRAM_CHAT_ID
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — TELEGRAM_CHAT_ID absent', () => {
    it('does NOT call telegram.sendMessage when TELEGRAM_CHAT_ID is absent', async () => {
      const cfgNoChatId = makeConfigService({ TELEGRAM_CHAT_ID: undefined });
      service = new NotificationsService(telegram, cfgNoChatId);

      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift detected' });

      expect(telegram.sendMessage).not.toHaveBeenCalled();
    });

    it('resolves without error when TELEGRAM_CHAT_ID is absent', async () => {
      const cfgNoChatId = makeConfigService({ TELEGRAM_CHAT_ID: undefined });
      service = new NotificationsService(telegram, cfgNoChatId);

      await expect(
        service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Silent drop: TelegramBotTokenMissingError
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — TelegramBotTokenMissingError', () => {
    it('swallows TelegramBotTokenMissingError (bot token absent)', async () => {
      (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TelegramBotTokenMissingError());

      await expect(
        service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' }),
      ).resolves.not.toThrow();
    });

    it('does NOT re-throw when bot token missing', async () => {
      (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new TelegramBotTokenMissingError());

      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' });

      // Should complete without crashing
      expect(true).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Silent drop: generic sendMessage error
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — generic adapter error', () => {
    it('swallows TelegramApiError (does not crash the caller)', async () => {
      (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new TelegramApiError('sendMessage', 'Chat not found'),
      );

      await expect(
        service.sendCriticalAlert({ type: 'system_health', agent: 'tracker', message: 'test' }),
      ).resolves.not.toThrow();
    });

    it('swallows generic Error from adapter', async () => {
      (telegram.sendMessage as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('unexpected network failure'));

      await expect(
        service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' }),
      ).resolves.not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Happy path: correct chatId and message passed to adapter
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — happy path', () => {
    it('calls telegram.sendMessage with correct chatId', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ chatId: '-1001234567890' }));
    });

    it('uses HTML parse mode', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ parseMode: 'HTML' }));
    });
  });

  // -------------------------------------------------------------------------
  // Topic routing
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — topic routing', () => {
    it('routes rug_warning to TG_TOPIC_ALERTS thread (101)', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: '101' }));
    });

    it('routes system_health to TG_TOPIC_OBSERVER thread (102)', async () => {
      await service.sendCriticalAlert({ type: 'system_health', agent: 'tracker', message: 'test' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: '102' }));
    });

    it('routes trade_executed to TG_TOPIC_EXECUTOR thread (103)', async () => {
      await service.sendCriticalAlert({ type: 'trade_executed', agent: 'tracker', message: 'test' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: '103' }));
    });

    it('threadId is undefined when topic env var is absent', async () => {
      const cfgNoTopics = makeConfigService({ TG_TOPIC_ALERTS: undefined });
      service = new NotificationsService(telegram, cfgNoTopics);

      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      expect(telegram.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ threadId: undefined }));
    });
  });

  // -------------------------------------------------------------------------
  // Message format
  // -------------------------------------------------------------------------

  describe('sendCriticalAlert() — message format', () => {
    it('includes emoji prefix in message', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'drift detected' });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      expect(callArg?.text).toMatch(/^🚨/);
    });

    it('includes [AGENT] in uppercase in message', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      expect(callArg?.text).toContain('[GOVERNANCE]');
    });

    it('includes SAFE_ID footer in message', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      expect(callArg?.text).toContain('test-fund');
    });

    it('includes the message body', async () => {
      await service.sendCriticalAlert({
        type: 'rug_warning',
        agent: 'governance',
        message: 'GOVERNANCE DRIFT on base',
      });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      expect(callArg?.text).toContain('GOVERNANCE DRIFT on base');
    });

    it('includes separator line in message', async () => {
      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      // Separator line is '────────────────'
      expect(callArg?.text).toContain('────────────────');
    });

    it('uses "unknown" as SAFE_ID when env var absent', async () => {
      const cfgNoSafeId = makeConfigService({ SAFE_ID: undefined });
      service = new NotificationsService(telegram, cfgNoSafeId);

      await service.sendCriticalAlert({ type: 'rug_warning', agent: 'governance', message: 'test' });

      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as {
        text: string;
      };
      expect(callArg?.text).toContain('unknown');
    });
  });

  // -------------------------------------------------------------------------
  // Convenience wrappers
  // -------------------------------------------------------------------------

  describe('convenience wrappers', () => {
    it('sendTradeExecuted calls sendCriticalAlert with type=trade_executed', async () => {
      await service.sendTradeExecuted('tracker', 'BUY confirmed');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '103' }), // TG_TOPIC_EXECUTOR
      );
      const callArg = (telegram.sendMessage as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as { text: string };
      expect(callArg?.text).toContain('BUY confirmed');
    });

    it('sendTradeFailed calls sendCriticalAlert with type=trade_failed', async () => {
      await service.sendTradeFailed('tracker', 'BUY rejected');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '103' }), // TG_TOPIC_EXECUTOR
      );
    });

    it('sendRugWarning calls sendCriticalAlert with type=rug_warning', async () => {
      await service.sendRugWarning('governance', 'drift');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '101' }), // TG_TOPIC_ALERTS
      );
    });

    it('sendSystemHealth calls sendCriticalAlert with type=system_health', async () => {
      await service.sendSystemHealth('tracker', 'pending tx');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '102' }), // TG_TOPIC_OBSERVER
      );
    });

    it('sendPortfolioDaily calls sendCriticalAlert with type=portfolio_daily', async () => {
      await service.sendPortfolioDaily('system', 'daily report');

      expect(telegram.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: '107' }), // TG_TOPIC_PORTFOLIO
      );
    });
  });
});
