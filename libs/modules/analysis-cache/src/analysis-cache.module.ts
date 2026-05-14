import { Module } from '@nestjs/common';
import { AnalysisCacheController } from './analysis-cache.controller.js';
import { AnalysisCacheService } from './analysis-cache.service.js';
import { AnalysisCacheRepository } from './analysis-cache.repository.js';

/**
 * Analysis cache module — token-level analysis verdict cache (SPEC §7, migration 006).
 *
 * PrismaModule and ConfigModule are global; no explicit imports needed.
 */
@Module({
  controllers: [AnalysisCacheController],
  providers: [AnalysisCacheService, AnalysisCacheRepository],
  exports: [AnalysisCacheService],
})
export class AnalysisCacheModule {}
