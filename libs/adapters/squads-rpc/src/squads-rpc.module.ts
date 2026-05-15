/**
 * SquadsRpcModule — NestJS module that provides SquadsRpcAdapter.
 *
 * Import this module in any NestJS module that needs Squads V4 RPC access.
 * ConfigModule is global; no explicit import needed here.
 */
import { Module } from '@nestjs/common';
import { SquadsRpcAdapter } from './squads-rpc.adapter.js';

@Module({
  providers: [SquadsRpcAdapter],
  exports: [SquadsRpcAdapter],
})
export class SquadsRpcModule {}
