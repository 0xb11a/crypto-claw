import { Module, type DynamicModule } from '@nestjs/common';
import { BirdeyeModule } from '@cclaw/adapters-birdeye';
import { SystemModule } from '@cclaw/system';
import { WalletsController } from './wallets.controller.js';
import { SignalsController } from './signals.controller.js';
import { WalletsService } from './wallets.service.js';
import { SignalsService } from './signals.service.js';
import { WalletsRepository } from './wallets.repository.js';
import { SignalsRepository } from './signals.repository.js';
import { HarvestProcessor } from './jobs/harvest.processor.js';

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
   * Queue registration (`BullModule.registerQueue`) is intentionally left to
   * `apps/worker/src/app.module.ts` so the retry/backoff policy lives in one
   * canonical place (ADR-0024 addendum; same pattern as execute-order).
   */
  static forWorker(): DynamicModule {
    return {
      module: WalletsModule,
      imports: [
        // BullModule.registerQueue with retry policy is registered in
        // apps/worker/src/app.module.ts (canonical policy location, ADR-0024
        // addendum). The processor WorkerHost requires the queue to already
        // be registered; apps/worker's app.module registers it before this
        // module is initialised.
        BirdeyeModule,
        SystemModule,
      ],
      providers: [WalletsRepository, SignalsRepository, HarvestProcessor],
      exports: [WalletsRepository, SignalsRepository],
    };
  }
}
