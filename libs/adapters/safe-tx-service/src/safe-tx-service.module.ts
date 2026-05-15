/**
 * SafeTxServiceModule — NestJS module that provides SafeTxServiceAdapter.
 *
 * Import this module in any NestJS module that needs Safe Transaction Service
 * API access. ConfigModule is global; no explicit import needed here.
 */
import { Module } from '@nestjs/common';
import { SafeTxServiceAdapter } from './safe-tx-service.adapter.js';

@Module({
  providers: [SafeTxServiceAdapter],
  exports: [SafeTxServiceAdapter],
})
export class SafeTxServiceModule {}
