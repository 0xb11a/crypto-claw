import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { SystemService } from '../system.service.js';
import { SyncStatusQueryDto } from '../dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from '../dto/portfolio-sync-response.dto.js';

/**
 * Portfolio sync controller — HTTP surface for portfolio_sync table (read-only).
 *
 * The portfolio_sync table is written by portfolio-load-evm.js and
 * portfolio-load-solana.js (legacy scripts). The NestJS API only exposes
 * read access to match the legacy get-sync-status command.
 *
 * Routes:
 *   GET /v1/system/sync-status?chain&limit  — list sync history (agent, dashboard)
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/sync-status')
export class PortfolioSyncController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List portfolio sync history' })
  @ApiResponse({ status: 200, description: 'Portfolio sync history rows' })
  getSyncStatus(@Query() query: SyncStatusQueryDto): Promise<PortfolioSyncResponseDto[]> {
    return this.svc.getSyncStatus(query);
  }
}
