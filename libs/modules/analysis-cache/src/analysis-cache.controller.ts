import { Controller, Get, Post, Delete, Body, Query, HttpCode, HttpStatus, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AnalysisCacheService } from './analysis-cache.service.js';
import { CacheAnalysisDto } from './dto/cache-analysis.dto.js';
import { AnalysisCacheQueryDto } from './dto/analysis-cache-query.dto.js';
import { CheckTokenStatusQueryDto } from './dto/check-token-status-query.dto.js';
import type { AnalysisCacheResponseDto } from './dto/analysis-cache-response.dto.js';

/**
 * Analysis cache controller — HTTP surface for the analysis_cache table (SPEC §7).
 *
 * Routes:
 *   GET    /v1/analysis-cache                        — list non-expired (agent, dashboard)
 *   POST   /v1/analysis-cache                        — upsert @Audited (agent)
 *   GET    /v1/analysis-cache/check?address&chain    — single-token cache check (agent, dashboard)
 *   DELETE /v1/analysis-cache/expired                — clear-expired-cache @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('analysis-cache')
@ApiBearerAuth()
@Controller('analysis-cache')
export class AnalysisCacheController {
  constructor(private readonly svc: AnalysisCacheService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List non-expired analysis cache entries' })
  @ApiResponse({ status: 200, description: 'Non-expired cache entries' })
  list(@Query() query: AnalysisCacheQueryDto): Promise<AnalysisCacheResponseDto[]> {
    return this.svc.listNonExpired(query);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Upsert a token analysis cache entry' })
  @ApiResponse({ status: 201, description: 'Cache entry upserted' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  upsert(@Body() dto: CacheAnalysisDto): Promise<AnalysisCacheResponseDto> {
    return this.svc.upsert(dto);
  }

  @Get('check')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Check token cache status (non-expired)' })
  @ApiResponse({ status: 200, description: 'Cache entry found' })
  @ApiResponse({ status: 404, description: 'No non-expired cache entry for this token' })
  async check(@Query() query: CheckTokenStatusQueryDto): Promise<AnalysisCacheResponseDto> {
    const entry = await this.svc.checkToken(query);
    if (!entry) throw new NotFoundException(`No cache entry for ${query.address} on ${query.chain}`);
    return entry;
  }

  @Delete('expired')
  @Roles('agent')
  @Audited()
  @ApiOperation({ summary: 'Delete all expired analysis cache entries' })
  @ApiResponse({ status: 200, description: 'Expired entries deleted' })
  async clearExpired(): Promise<{ ok: boolean; deleted: number }> {
    const deleted = await this.svc.clearExpired();
    return { ok: true, deleted };
  }
}
