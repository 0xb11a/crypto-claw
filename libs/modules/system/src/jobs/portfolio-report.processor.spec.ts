/**
 * Unit tests for PortfolioReportProcessor (DoD §A, §E).
 *
 * All dependencies are mocked at the class boundary.
 *
 * Covers:
 *   - TELEGRAM_CHAT_ID not set → skipped=true, meta written.
 *   - TG_TOPIC_PORTFOLIO not set → skipped=true, meta written.
 *   - Normal run → sendPortfolioDaily called, meta written, sent=true.
 *   - buildReport throws → error re-thrown (BullMQ retry).
 *   - Telegram send fails → swallowed, meta still written.
 *   - setMeta always called (DoD §E idempotency).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { PortfolioReportProcessor } from './portfolio-report.processor.js';
import type { PortfolioReportJobData } from './portfolio-report.processor.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJob(): Job<PortfolioReportJobData> {
  return { id: 'test-portfolio-job-1', data: {} } as unknown as Job<PortfolioReportJobData>;
}

function makeServices(
  overrides: {
    chatId?: string;
    topicPortfolio?: string;
    reportThrows?: boolean;
    sendThrows?: boolean;
  } = {},
) {
  const { chatId = 'chat-123', topicPortfolio = 'thread-456', reportThrows = false, sendThrows = false } = overrides;

  const summaryService = {
    buildReport: reportThrows
      ? vi.fn().mockRejectedValue(new Error('DEXScreener down'))
      : vi.fn().mockResolvedValue({ status: 'ok', timestamp: '2026-05-14T00:00:00.000Z' }),
    formatForTelegram: vi.fn().mockReturnValue('Formatted report message'),
  };

  const notifications = {
    sendPortfolioDaily: sendThrows
      ? vi.fn().mockRejectedValue(new Error('Telegram timeout'))
      : vi.fn().mockResolvedValue(undefined),
  };

  const systemService = {
    setMeta: vi.fn().mockResolvedValue({ ok: true }),
  };

  const configService = {
    get: vi.fn((key: string) => {
      if (key === 'TELEGRAM_CHAT_ID') return chatId;
      if (key === 'TG_TOPIC_PORTFOLIO') return topicPortfolio;
      return undefined;
    }),
  };

  return { summaryService, notifications, systemService, configService };
}

function makeProcessor(services: ReturnType<typeof makeServices>): PortfolioReportProcessor {
  return new PortfolioReportProcessor(
    services.summaryService as unknown as ConstructorParameters<typeof PortfolioReportProcessor>[0],
    services.notifications as unknown as ConstructorParameters<typeof PortfolioReportProcessor>[1],
    services.systemService as unknown as ConstructorParameters<typeof PortfolioReportProcessor>[2],
    services.configService as unknown as ConstructorParameters<typeof PortfolioReportProcessor>[3],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PortfolioReportProcessor', () => {
  beforeEach(() => {
    vi.spyOn(Logger.prototype, 'log').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => {});
    vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {});
  });

  // -------------------------------------------------------------------------
  // Telegram not configured
  // -------------------------------------------------------------------------

  describe('TELEGRAM_CHAT_ID not set', () => {
    it('returns skipped=true', async () => {
      const services = makeServices();
      // Override configService to return undefined for TELEGRAM_CHAT_ID
      (services.configService.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'TELEGRAM_CHAT_ID') return undefined;
        if (key === 'TG_TOPIC_PORTFOLIO') return 'thread-456';
        return undefined;
      });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(true);
      expect(result.sent).toBe(false);
    });

    it('writes last_portfolio_report_at meta when skipped', async () => {
      const services = makeServices();
      (services.configService.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'TELEGRAM_CHAT_ID') return undefined;
        return undefined;
      });
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'last_portfolio_report_at' }),
      );
    });
  });

  describe('TG_TOPIC_PORTFOLIO not set', () => {
    it('returns skipped=true', async () => {
      const services = makeServices();
      (services.configService.get as ReturnType<typeof vi.fn>).mockImplementation((key: string) => {
        if (key === 'TELEGRAM_CHAT_ID') return 'chat-123';
        if (key === 'TG_TOPIC_PORTFOLIO') return undefined;
        return undefined;
      });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(result.skipped).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Normal run
  // -------------------------------------------------------------------------

  describe('normal run', () => {
    it('calls buildReport and sendPortfolioDaily', async () => {
      const services = makeServices();
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(services.summaryService.buildReport).toHaveBeenCalledOnce();
      expect(services.notifications.sendPortfolioDaily).toHaveBeenCalledOnce();
      expect(result.sent).toBe(true);
      expect(result.skipped).toBe(false);
    });

    it('writes last_portfolio_report_at meta', async () => {
      const services = makeServices();
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'last_portfolio_report_at' }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Error cases
  // -------------------------------------------------------------------------

  describe('buildReport throws', () => {
    it('re-throws error for BullMQ retry', async () => {
      const services = makeServices({ reportThrows: true });
      const processor = makeProcessor(services);

      await expect(processor.process(makeJob())).rejects.toThrow('DEXScreener down');
    });
  });

  describe('Telegram send fails', () => {
    it('swallows error and still writes meta', async () => {
      const services = makeServices({ sendThrows: true });
      const processor = makeProcessor(services);

      const result = await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalled();
      // sent=true because the send was attempted (error was swallowed)
      expect(result.sent).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // setMeta always called (DoD §E)
  // -------------------------------------------------------------------------

  describe('setMeta always called', () => {
    it('writes meta on normal run', async () => {
      const services = makeServices();
      const processor = makeProcessor(services);

      await processor.process(makeJob());

      expect(services.systemService.setMeta).toHaveBeenCalledTimes(1);
    });
  });
});
