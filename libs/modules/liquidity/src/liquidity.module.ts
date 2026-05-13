import { Module } from '@nestjs/common';
import { LiquidityController } from './liquidity.controller.js';
import { LiquidityService } from './liquidity.service.js';
import { LiquidityRepository } from './liquidity.repository.js';

/**
 * Liquidity module — wires liquidity_snapshots table.
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [LiquidityController],
  providers: [LiquidityService, LiquidityRepository],
  exports: [LiquidityService],
})
export class LiquidityModule {}
