import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DexscreenerModule } from '@cclaw/adapters-dexscreener';
import { NotificationsModule } from '@cclaw/notifications';
import { MetaController } from './controllers/meta.controller.js';
import { CashController } from './controllers/cash.controller.js';
import { PortfolioSyncController } from './controllers/portfolio-sync.controller.js';
import { SystemService } from './system.service.js';
import { SystemRepository } from './system.repository.js';
import { PortfolioSummaryService } from './jobs/portfolio-summary.service.js';
import { PortfolioReportProcessor } from './jobs/portfolio-report.processor.js';
import { PORTFOLIO_REPORT_QUEUE, PORTFOLIO_REPORT_JOB_OPTIONS } from './jobs/queue-names.js';

/**
 * System module — portfolio_meta + portfolio_sync access (SPEC §7).
 *
 * Two static factory methods:
 *
 *   - `SystemModule` (default import) — used by apps/api and other modules.
 *     Registers HTTP controllers + service/repository. Exported so any module
 *     that needs `SystemService` can import `SystemModule`.
 *
 *   - `SystemModule.forWorker()` — used by apps/worker. Omits HTTP controllers;
 *     registers BullMQ portfolio-report processor + adapter/service dependencies.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [MetaController, CashController, PortfolioSyncController],
  providers: [SystemService, SystemRepository],
  exports: [SystemService],
})
export class SystemModule {
  /**
   * Worker-side factory — registers the portfolio-report BullMQ processor.
   *
   * Does NOT register HTTP controllers (those are on the default module above).
   * Imports DexscreenerModule, NotificationsModule, and PositionsModule so the
   * processor and PortfolioSummaryService can resolve all their dependencies.
   *
   * Queue registration lives here (not in apps/worker/src/app.module.ts) so the
   * `@Processor(PORTFOLIO_REPORT_QUEUE)` in PortfolioReportProcessor resolves
   * correctly within this module's context.
   */
  static forWorker(): DynamicModule {
    return {
      module: SystemModule,
      imports: [
        BullModule.registerQueue({
          name: PORTFOLIO_REPORT_QUEUE,
          defaultJobOptions: { ...PORTFOLIO_REPORT_JOB_OPTIONS },
        }),
        DexscreenerModule,
        NotificationsModule,
      ],
      providers: [SystemService, SystemRepository, PortfolioSummaryService, PortfolioReportProcessor],
      exports: [SystemService],
    };
  }
}
