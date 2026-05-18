import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { DexscreenerModule } from '@cclaw/adapters-dexscreener';
import { NotificationsModule } from '@cclaw/notifications';
import { MetaController } from './controllers/meta.controller.js';
import { CashController } from './controllers/cash.controller.js';
import { PortfolioSyncController } from './controllers/portfolio-sync.controller.js';
import { PortfolioController } from './controllers/portfolio.controller.js';
import { TradeStatsController } from './controllers/trade-stats.controller.js';
import { ChainsController } from './controllers/chains.controller.js';
import { SyncPortfolioController } from './controllers/sync-portfolio.controller.js';
import { SystemService, SYNC_POSITION_RECONCILE_QUEUE } from './system.service.js';
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
 *     Registers HTTP controllers + service/repository. Also registers the
 *     `position-reconcile` BullMQ queue so SyncPortfolioController's
 *     @InjectQueue resolves at boot (PR-B/PR-C lesson; queue must be in
 *     the same module as the controller that injects it).
 *
 *   - `SystemModule.forWorker()` — used by apps/worker. Omits HTTP controllers;
 *     registers BullMQ portfolio-report processor + adapter/service dependencies.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  imports: [
    // Register position-reconcile queue so SyncPortfolioController's
    // @InjectQueue('position-reconcile') in SystemService resolves at boot.
    // The processor itself stays in PositionsModule.forWorker() — only the
    // queue provider is needed here (read: an enqueue-side registration).
    BullModule.registerQueue({ name: SYNC_POSITION_RECONCILE_QUEUE }),
  ],
  controllers: [
    MetaController,
    CashController,
    PortfolioSyncController,
    PortfolioController,
    TradeStatsController,
    ChainsController,
    SyncPortfolioController,
  ],
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
        // position-reconcile queue must also be registered here because
        // SystemService (used by the worker) injects it via @InjectQueue.
        BullModule.registerQueue({ name: SYNC_POSITION_RECONCILE_QUEUE }),
        DexscreenerModule,
        NotificationsModule,
      ],
      providers: [SystemService, SystemRepository, PortfolioSummaryService, PortfolioReportProcessor],
      exports: [SystemService],
    };
  }
}
