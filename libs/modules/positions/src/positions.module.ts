import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { OnchainBalanceModule } from '@cclaw/adapters-onchain-balance';
import { NotificationsModule } from '@cclaw/notifications';
import { SystemModule } from '@cclaw/system';
import { PositionsController } from './positions.controller.js';
import { PositionsService } from './positions.service.js';
import { PositionsRepository } from './positions.repository.js';
import { PositionReconcileProcessor } from './jobs/position-reconcile.processor.js';
import { POSITION_RECONCILE_QUEUE, POSITION_RECONCILE_JOB_OPTIONS } from './jobs/queue-names.js';

/**
 * Positions module — wires controller, service, and repository.
 *
 * Two static factory methods:
 *
 *   - `PositionsModule` (default import) — used by apps/api and by other
 *     modules that import positions. Registers HTTP controller + service/repository.
 *
 *   - `PositionsModule.forWorker()` — used by apps/worker. Omits HTTP
 *     controllers; registers BullMQ processor + adapter/service dependencies
 *     for the position-reconcile job.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [PositionsController],
  providers: [PositionsService, PositionsRepository],
  exports: [PositionsService, PositionsRepository],
})
export class PositionsModule {
  /**
   * Worker-side factory — registers the position-reconcile BullMQ processor.
   *
   * Does NOT register HTTP controllers (those are on the default module above).
   * Imports OnchainBalanceModule, NotificationsModule, and SystemModule so the
   * processor can resolve all its dependencies.
   *
   * Queue registration lives here (not in apps/worker/src/app.module.ts) so
   * the `@Processor(POSITION_RECONCILE_QUEUE)` in PositionReconcileProcessor
   * resolves correctly within this module's context.
   */
  static forWorker(): DynamicModule {
    return {
      module: PositionsModule,
      imports: [
        BullModule.registerQueue({
          name: POSITION_RECONCILE_QUEUE,
          defaultJobOptions: { ...POSITION_RECONCILE_JOB_OPTIONS },
        }),
        OnchainBalanceModule,
        NotificationsModule,
        SystemModule,
      ],
      providers: [PositionsRepository, PositionsService, PositionReconcileProcessor],
      exports: [PositionsService, PositionsRepository],
    };
  }
}
