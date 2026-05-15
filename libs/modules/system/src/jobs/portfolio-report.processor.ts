/**
 * portfolio-report.processor.ts — BullMQ processor for portfolio-report jobs.
 *
 * Ports the daily Telegram report emit from `scripts/portfolio-summary.js`
 * into a standalone, idempotent NestJS processor.
 *
 * Per-cycle algorithm:
 *   1. Bail if TELEGRAM_CHAT_ID or TG_TOPIC_PORTFOLIO is unset (parity with
 *      `entrypoint.sh:1025` — skip if Telegram not configured).
 *   2. Build portfolio report via `PortfolioSummaryService.buildReport()`.
 *   3. Format and send via `NotificationsService.sendPortfolioDaily()`.
 *   4. Write `systemService.setMeta('last_portfolio_report_at', now)`.
 *
 * Idempotency (DoD §E):
 *   Running twice leaves the DB identical except `last_portfolio_report_at`.
 *   The Telegram message is sent twice (no dedup — consistent with legacy cron).
 *
 * Config access (ADR-0026 — per-field):
 *   - `TELEGRAM_CHAT_ID`     — required for report delivery.
 *   - `TG_TOPIC_PORTFOLIO`   — required for topic routing.
 *   - `PAPER_MODE`           — passed to PortfolioSummaryService.
 *
 * SPEC §4 #6 — no `process.env` reads.
 */
import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Job } from 'bullmq';
import { NotificationsService } from '@cclaw/notifications';
import { SystemService } from '../system.service.js';
import { PortfolioSummaryService } from './portfolio-summary.service.js';
import { PORTFOLIO_REPORT_QUEUE } from './queue-names.js';

/** BullMQ job payload — empty (all config resolved via ConfigService). */
export type PortfolioReportJobData = Record<string, never>;

/** Structured return value for observability. */
export interface PortfolioReportResult {
  sent: boolean;
  skipped: boolean;
  skipReason?: string;
}

/**
 * BullMQ processor for portfolio-report jobs.
 *
 * Job topology (P3g2 plan, Queue topology):
 *   Queue: `portfolio-report` — global singleton.
 *   Concurrency: 1 — one in-flight cycle at a time.
 *   Retry: 2 attempts, fixed 60 s backoff.
 */
@Processor(PORTFOLIO_REPORT_QUEUE, { concurrency: 1 })
export class PortfolioReportProcessor extends WorkerHost {
  private readonly logger = new Logger(PortfolioReportProcessor.name);

  constructor(
    private readonly summaryService: PortfolioSummaryService,
    private readonly notifications: NotificationsService,
    private readonly systemService: SystemService,
    private readonly configService: ConfigService,
  ) {
    super();
  }

  /**
   * Process a portfolio-report job.
   *
   * One job = build + send the daily Telegram digest.
   */
  async process(job: Job<PortfolioReportJobData>): Promise<PortfolioReportResult> {
    this.logger.log(`portfolio-report: starting job ${job.id}`);

    // 1. Bail if Telegram not configured (matches entrypoint.sh:1025 skip).
    const chatId = this.configService.get<string>('TELEGRAM_CHAT_ID');
    const topicPortfolio = this.configService.get<string>('TG_TOPIC_PORTFOLIO');

    if (!chatId) {
      this.logger.debug('portfolio-report: TELEGRAM_CHAT_ID not set — skipping');
      await this.systemService.setMeta({ key: 'last_portfolio_report_at', value: new Date().toISOString() });
      return { sent: false, skipped: true, skipReason: 'TELEGRAM_CHAT_ID not set' };
    }

    if (!topicPortfolio) {
      this.logger.debug('portfolio-report: TG_TOPIC_PORTFOLIO not set — skipping');
      await this.systemService.setMeta({ key: 'last_portfolio_report_at', value: new Date().toISOString() });
      return { sent: false, skipped: true, skipReason: 'TG_TOPIC_PORTFOLIO not set' };
    }

    // 2. Build portfolio report.
    let message: string;
    try {
      const report = await this.summaryService.buildReport();
      message = this.summaryService.formatForTelegram(report);
    } catch (err) {
      this.logger.error(`portfolio-report: failed to build report: ${(err as Error).message}`);
      throw err; // Let BullMQ retry.
    }

    // 3. Send via NotificationsService.
    try {
      await this.notifications.sendPortfolioDaily('system', message);
      this.logger.log('portfolio-report: Telegram message sent');
    } catch (err) {
      // Log and swallow — alerting must not block the meta write.
      this.logger.warn(`portfolio-report: Telegram send failed: ${(err as Error).message}`);
    }

    // 4. Write health meta (always).
    await this.systemService.setMeta({ key: 'last_portfolio_report_at', value: new Date().toISOString() });

    return { sent: true, skipped: false };
  }
}
