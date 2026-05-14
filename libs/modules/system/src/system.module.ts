import { Module } from '@nestjs/common';
import { MetaController } from './controllers/meta.controller.js';
import { CashController } from './controllers/cash.controller.js';
import { PortfolioSyncController } from './controllers/portfolio-sync.controller.js';
import { SystemService } from './system.service.js';
import { SystemRepository } from './system.repository.js';

/**
 * System module — portfolio_meta + portfolio_sync access (SPEC §7).
 *
 * Uses a single repository (SystemRepository) and service (SystemService)
 * with three sub-controllers organized by resource:
 *  - MetaController:          GET/PATCH /v1/system/meta
 *  - CashController:          GET/PATCH /v1/system/cash, GET /v1/system/gas
 *  - PortfolioSyncController: GET /v1/system/sync-status
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [MetaController, CashController, PortfolioSyncController],
  providers: [SystemService, SystemRepository],
  exports: [SystemService],
})
export class SystemModule {}
