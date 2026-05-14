import { Injectable } from '@nestjs/common';
import { AnalysisCacheRepository } from './analysis-cache.repository.js';
import type { CacheAnalysisDto } from './dto/cache-analysis.dto.js';
import type { AnalysisCacheQueryDto } from './dto/analysis-cache-query.dto.js';
import type { CheckTokenStatusQueryDto } from './dto/check-token-status-query.dto.js';
import type { AnalysisCacheResponseDto } from './dto/analysis-cache-response.dto.js';

/**
 * Analysis cache service — thin orchestration layer between controllers and repository.
 */
@Injectable()
export class AnalysisCacheService {
  constructor(private readonly repo: AnalysisCacheRepository) {}

  /** Upsert a cache entry with a TTL. */
  upsert(dto: CacheAnalysisDto): Promise<AnalysisCacheResponseDto> {
    return this.repo.upsert(dto);
  }

  /** List all non-expired cache entries. */
  listNonExpired(query: AnalysisCacheQueryDto): Promise<AnalysisCacheResponseDto[]> {
    return this.repo.findNonExpired(query);
  }

  /** Single-token cache lookup (non-expired). Returns null if not cached. */
  checkToken(query: CheckTokenStatusQueryDto): Promise<AnalysisCacheResponseDto | null> {
    return this.repo.findByAddressChain(query);
  }

  /** Delete all expired entries. Returns deleted count. */
  clearExpired(): Promise<number> {
    return this.repo.deleteExpiredBatch();
  }
}
