import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { SystemService } from '../system.service.js';
import { TradeStatsQueryDto } from '../dto/trade-stats-query.dto.js';
import type { TradeStatsResponseDto } from '../dto/trade-stats-response.dto.js';

/**
 * Trade stats controller — HTTP surface for aggregated trade statistics.
 *
 * Routes:
 *   GET /v1/system/trade-stats             — all-chains stats (agent, dashboard)
 *   GET /v1/system/trade-stats?chain=X     — single-chain stats (agent, dashboard)
 *   GET /v1/system/trade-stats?mode=paper  — paper-mode override (agent, dashboard)
 *
 * Mirrors legacy db-query.js `get-trade-stats` command (lines 1447-1498).
 * The 12+ stat fields are explicitly mapped from snake_case $queryRaw result to
 * avoid the silent-null bug (recurring failure pattern, SPEC P5b plan risk §3).
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/trade-stats')
export class TradeStatsController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get aggregated trade statistics' })
  @ApiResponse({ status: 200, description: 'Trade statistics: wins/losses/PnL/win-rate/returns' })
  getTradeStats(@Query() query: TradeStatsQueryDto): Promise<TradeStatsResponseDto> {
    return this.svc.getTradeStats(query.chain, query.mode);
  }
}
