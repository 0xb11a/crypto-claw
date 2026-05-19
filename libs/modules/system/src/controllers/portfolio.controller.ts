import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { SystemService } from '../system.service.js';
import { PortfolioQueryDto } from '../dto/portfolio-query.dto.js';
import type { PortfolioResponseDto, PortfolioSingleChainResponseDto } from '../dto/portfolio-response.dto.js';

/**
 * Portfolio controller — HTTP surface for portfolio snapshots (SPEC §7 system module).
 *
 * Routes:
 *   GET /v1/system/portfolio              — all-chains portfolio (agent, dashboard)
 *   GET /v1/system/portfolio?chain=X      — single-chain portfolio (agent, dashboard)
 *   GET /v1/system/portfolio?mode=paper   — paper-mode override (agent, dashboard)
 *
 * Mirrors legacy db-query.js `get-portfolio` command (lines 454-499).
 * When ?chain is omitted, iterates getAllChains() (NOT just ACTIVE_CHAINS) per parity.
 * Auto-routes by PAPER_MODE when ?mode is omitted.
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/portfolio')
export class PortfolioController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get portfolio snapshot (all chains or a specific chain)' })
  @ApiResponse({ status: 200, description: 'Portfolio snapshot with positions and cash balances' })
  getPortfolio(@Query() query: PortfolioQueryDto): Promise<PortfolioResponseDto | PortfolioSingleChainResponseDto> {
    return this.svc.getPortfolio(query.chain, query.mode);
  }
}
