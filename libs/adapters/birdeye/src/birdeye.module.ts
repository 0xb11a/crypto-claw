/**
 * BirdeyeModule — NestJS module that provides BirdeyeAdapter.
 *
 * Import this module in any NestJS module that needs Birdeye API access.
 * ConfigModule is global; no explicit import needed here.
 *
 * Example:
 * ```ts
 * @Module({
 *   imports: [BirdeyeModule],
 *   providers: [HarvestProcessor],
 * })
 * export class WalletsWorkerModule {}
 * ```
 */
import { Module } from '@nestjs/common';
import { BirdeyeAdapter } from './birdeye.adapter.js';

@Module({
  providers: [BirdeyeAdapter],
  exports: [BirdeyeAdapter],
})
export class BirdeyeModule {}
