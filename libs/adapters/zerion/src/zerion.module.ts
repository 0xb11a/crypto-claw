/**
 * ZerionModule — NestJS module that provides ZerionAdapter.
 *
 * Import this module in any NestJS module that needs Zerion API access.
 * ConfigModule is global; no explicit import needed here.
 *
 * Example:
 * ```ts
 * @Module({
 *   imports: [ZerionModule],
 *   providers: [ScoreWalletsProcessor],
 * })
 * export class WalletsWorkerModule {}
 * ```
 */
import { Module } from '@nestjs/common';
import { ZerionAdapter } from './zerion.adapter.js';

@Module({
  providers: [ZerionAdapter],
  exports: [ZerionAdapter],
})
export class ZerionModule {}
