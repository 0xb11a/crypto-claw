import { Module, type DynamicModule } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BirdeyeModule } from '@cclaw/adapters-birdeye';
import { ZerionModule } from '@cclaw/adapters-zerion';
import { SystemModule } from '@cclaw/system';
import { WalletsController } from './wallets.controller.js';
import { SignalsController } from './signals.controller.js';
import { WalletsService } from './wallets.service.js';
import { SignalsService } from './signals.service.js';
import { WalletsRepository } from './wallets.repository.js';
import { SignalsRepository } from './signals.repository.js';
import { HarvestProcessor } from './jobs/harvest.processor.js';
import { ScoreWalletsProcessor } from './jobs/score-wallets.processor.js';
import { ScoreWalletService } from './jobs/score-wallet.service.js';
import {
  WALLET_HARVEST_QUEUE,
  WALLET_SCORING_QUEUE,
  WALLET_HARVEST_JOB_OPTIONS,
  WALLET_SCORING_JOB_OPTIONS,
} from './jobs/queue-names.js';

/**
 * Wallets module — wires tracked_wallets and smart_money_signals.
 *
 * Both tables live in the same NestJS module per SPEC §7 (3-module alignment).
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 *
 * Two static factory methods are provided to keep the API surface and the
 * worker surface cleanly separated:
 *
 *   - `WalletsModule` (default import) — used by apps/api. Registers HTTP
 *     controllers + service/repository providers only. No BullMQ processors
 *     are registered, so the API process never imports BullMQ.
 *
 *   - `WalletsModule.forWorker()` — used by apps/worker. Omits HTTP
 *     controllers; registers BullMQ processor(s) + their adapter/service
 *     dependencies. Safe to call multiple times (idempotent because NestJS
 *     DynamicModule deduplicates).
 *
 * PR-B and PR-C extend `forWorker()` by appending their processors to the
 * providers array. Until then, `forWorker()` registers the HarvestProcessor
 * only.
 */
@Module({
  controllers: [WalletsController, SignalsController],
  providers: [WalletsService, SignalsService, WalletsRepository, SignalsRepository],
  exports: [WalletsService, SignalsService],
})
export class WalletsModule {
  /**
   * Worker-side factory — registers BullMQ processors for the wallet pipeline.
   *
   * Does NOT register HTTP controllers (those are on the default module above).
   * Imports BirdeyeModule and SystemModule so the HarvestProcessor can resolve
   * its BirdeyeAdapter and SystemService dependencies.
   *
   * Queue registration lives here (not in apps/worker/src/app.module.ts) so the
   * `@InjectQueue(WALLET_HARVEST_QUEUE)` in ScoreWalletsProcessor resolves
   * correctly. NestJS BullMQ's `registerQueue` is module-scoped; the Queue
   * provider must be visible in the same module that declares the consumer
   * processor. The `defaultJobOptions` constants live in libs/modules/wallets
   * so apps/worker and apps/scheduler import the same policy.
   */
  static forWorker(): DynamicModule {
    return {
      module: WalletsModule,
      imports: [
        BullModule.registerQueue(
          { name: WALLET_HARVEST_QUEUE, defaultJobOptions: { ...WALLET_HARVEST_JOB_OPTIONS } },
          { name: WALLET_SCORING_QUEUE, defaultJobOptions: { ...WALLET_SCORING_JOB_OPTIONS } },
        ),
        BirdeyeModule,
        ZerionModule,
        SystemModule,
      ],
      providers: [
        WalletsRepository,
        SignalsRepository,
        HarvestProcessor,
        // PR-B additions: ScoreWalletsProcessor and its pure-function dependency.
        // ScoreWalletService is not @Injectable() — provide as a value so NestJS
        // can inject it without requiring an @Injectable() decorator.
        { provide: ScoreWalletService, useValue: new ScoreWalletService() },
        ScoreWalletsProcessor,
      ],
      exports: [WalletsRepository, SignalsRepository],
    };
  }
}
