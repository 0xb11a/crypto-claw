import { Module } from '@nestjs/common';
import { WalletsController } from './wallets.controller.js';
import { SignalsController } from './signals.controller.js';
import { WalletsService } from './wallets.service.js';
import { SignalsService } from './signals.service.js';
import { WalletsRepository } from './wallets.repository.js';
import { SignalsRepository } from './signals.repository.js';

/**
 * Wallets module — wires tracked_wallets and smart_money_signals.
 *
 * Both tables live in the same NestJS module per SPEC §7 (3-module alignment).
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [WalletsController, SignalsController],
  providers: [WalletsService, SignalsService, WalletsRepository, SignalsRepository],
  exports: [WalletsService, SignalsService],
})
export class WalletsModule {}
