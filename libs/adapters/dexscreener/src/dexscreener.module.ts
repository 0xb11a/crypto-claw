/**
 * DexscreenerModule — NestJS module providing DexscreenerAdapter.
 *
 * Import this module in any NestJS module that needs DEXScreener price lookups.
 * ConfigModule is global; no explicit import needed here.
 */
import { Module } from '@nestjs/common';
import { DexscreenerAdapter } from './dexscreener.adapter.js';

@Module({
  providers: [DexscreenerAdapter],
  exports: [DexscreenerAdapter],
})
export class DexscreenerModule {}
