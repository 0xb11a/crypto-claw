import { Controller, Get, Param, NotFoundException } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { SystemService } from '../system.service.js';
import type { ChainsResponseDto } from '../dto/chains-response.dto.js';
import type { ChainConfigResponseDto } from '../dto/chain-config-response.dto.js';

/**
 * Chains controller — HTTP surface for chain configuration (SPEC §7 system module).
 *
 * Routes:
 *   GET /v1/system/chains         — { active: string[], all: string[] } (agent, dashboard)
 *   GET /v1/system/chains/:chain  — full chain config shape (agent, dashboard)
 *
 * No DB access — reads from @cclaw/chain helpers and ConfigService.
 * Mirrors legacy db-query.js `get-chains` and `get-chain-config` commands
 * (lines 546-571).
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/chains')
export class ChainsController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'List active and all known chains' })
  @ApiResponse({ status: 200, description: '{ active: string[], all: string[] }' })
  getChains(): ChainsResponseDto {
    return this.svc.getChains();
  }

  @Get(':chain')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiParam({ name: 'chain', description: 'Chain identifier (e.g. base, solana, ethereum)' })
  @ApiOperation({ summary: 'Get configuration for a specific chain' })
  @ApiResponse({ status: 200, description: 'Full chain configuration including portfolio rules' })
  @ApiResponse({ status: 404, description: 'Unknown chain' })
  getChainConfig(@Param('chain') chain: string): ChainConfigResponseDto {
    try {
      return this.svc.getChainConfig(chain);
    } catch {
      // getChain() throws Error with message "Unknown chain: <name>"
      throw new NotFoundException(`Unknown chain: ${chain}`);
    }
  }
}
