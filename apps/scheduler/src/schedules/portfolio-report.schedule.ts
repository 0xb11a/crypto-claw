/**
 * portfolio-report.schedule.ts — Dynamic cron schedule for the portfolio-report job.
 *
 * [OPEN-5] RESOLUTION: Uses `SchedulerRegistry.addCronJob` in `onModuleInit` to
 * register a dynamic cron expression at the configured UTC hour. This is chosen
 * over `@Cron` with an interpolated string because:
 *   - `@Cron` requires a compile-time-known string (or CronExpression enum value)
 *     when used as a decorator — runtime values require the registry API.
 *   - The hourly-poll-with-gate alternative (@Cron('0 * * * *') + if-check) would
 *     enqueue at the wrong time in the 1-minute window before midnight when the
 *     cron fires but the hour check hasn't changed yet.
 *   - `SchedulerRegistry.addCronJob` is the NestJS-idiomatic approach for dynamic
 *     expressions (documented in @nestjs/schedule dynamic-cron section).
 *
 * Behavior:
 *   - If `PORTFOLIO_REPORT_HOUR` is not configured: logs startup warning, skips
 *     registration entirely (parity with `entrypoint.sh:1025` skip).
 *   - If `TELEGRAM_CHAT_ID` is not configured: logs startup warning, skips.
 *   - Otherwise: registers a cron job for `0 H * * *` at module init.
 *
 * Cadence: `0 H * * *` (daily at `PORTFOLIO_REPORT_HOUR` UTC hour, default: 0).
 * Matches `entrypoint.sh:run_portfolio_report_loop` cadence (DoD §I — parity).
 *
 * Config access (ADR-0026 — per-field):
 *   - `PORTFOLIO_REPORT_HOUR` — UTC hour (integer 0–23, default 0).
 *   - `TELEGRAM_CHAT_ID`      — required for report delivery.
 *   - `TG_TOPIC_PORTFOLIO`    — required for topic routing.
 *
 * SPEC §4 #6 — no `process.env` reads.
 */
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { CronJob } from 'cron';
import { PORTFOLIO_REPORT_QUEUE } from '@cclaw/system';

@Injectable()
export class PortfolioReportSchedule implements OnModuleInit {
  private readonly logger = new Logger(PortfolioReportSchedule.name);

  constructor(
    @InjectQueue(PORTFOLIO_REPORT_QUEUE) private readonly portfolioReportQueue: Queue,
    private readonly schedulerRegistry: SchedulerRegistry,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Register the portfolio-report cron job at module init.
   *
   * Called once at startup. If configuration is missing, logs a warning
   * and skips registration (no cron, no enqueue).
   */
  onModuleInit(): void {
    // ADR-0026 per-field config reads.
    const reportHour = this.configService.get<number>('PORTFOLIO_REPORT_HOUR');
    const chatId = this.configService.get<string>('TELEGRAM_CHAT_ID');
    const topicPortfolio = this.configService.get<string>('TG_TOPIC_PORTFOLIO');

    if (!chatId || !topicPortfolio) {
      this.logger.warn(
        'portfolio-report: TELEGRAM_CHAT_ID or TG_TOPIC_PORTFOLIO not set — ' +
          'daily portfolio report schedule not registered',
      );
      return;
    }

    // PORTFOLIO_REPORT_HOUR is optional (defaults to 0 in schema) but we
    // also handle the case where it evaluates to undefined (schema default not applied
    // in test contexts). Use 0 as the safe fallback.
    const hour = typeof reportHour === 'number' && Number.isFinite(reportHour) ? reportHour : 0;

    const cronExpression = `0 ${hour} * * *`;
    this.logger.log(
      `portfolio-report: registering daily schedule at ${cronExpression} UTC (PORTFOLIO_REPORT_HOUR=${hour})`,
    );

    const job = new CronJob(cronExpression, async () => {
      this.logger.log(`portfolio-report: enqueuing daily portfolio report (hour=${hour})`);
      await this.portfolioReportQueue.add('portfolio-report', {});
    });

    this.schedulerRegistry.addCronJob('portfolio-report', job);
    job.start();
  }
}
