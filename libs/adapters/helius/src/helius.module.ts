/**
 * HeliusModule — NestJS module that provides HeliusAdapter.
 *
 * Import this module in any NestJS module that needs Helius API access.
 * ConfigModule is global; no explicit import needed here.
 *
 * Example:
 * ```ts
 * @Module({
 *   imports: [HeliusModule],
 *   providers: [ActivityWalletsProcessor],
 * })
 * export class WalletsWorkerModule {}
 * ```
 */
import { Module } from '@nestjs/common';
import { HeliusAdapter } from './helius.adapter.js';

@Module({
  providers: [HeliusAdapter],
  exports: [HeliusAdapter],
})
export class HeliusModule {}
