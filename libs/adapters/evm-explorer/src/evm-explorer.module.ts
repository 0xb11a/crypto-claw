/**
 * EvmExplorerModule — NestJS module that provides EvmExplorerAdapter.
 *
 * Import this module in any NestJS module that needs Etherscan-compatible
 * EVM explorer access. ConfigModule is global; no explicit import needed here.
 *
 * Example:
 * ```ts
 * @Module({
 *   imports: [EvmExplorerModule],
 *   providers: [ActivityWalletsProcessor],
 * })
 * export class WalletsWorkerModule {}
 * ```
 */
import { Module } from '@nestjs/common';
import { EvmExplorerAdapter } from './evm-explorer.adapter.js';

@Module({
  providers: [EvmExplorerAdapter],
  exports: [EvmExplorerAdapter],
})
export class EvmExplorerModule {}
