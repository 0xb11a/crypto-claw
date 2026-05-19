import { Controller, Get, Patch, Query, Param, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { SystemService } from '../system.service.js';
import { SetCashDto } from '../dto/set-cash.dto.js';
import { GasQueryDto } from '../dto/gas-query.dto.js';
import type { CashByChainDto } from '../dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from '../dto/cash-breakdown.dto.js';
import type { GasResponseDto } from '../dto/gas-query.dto.js';

/**
 * Cash controller — HTTP surface for cash and gas balance operations (portfolio_meta).
 *
 * Routes:
 *   GET   /v1/system/cash             — all-chains cash breakdown (agent, dashboard)
 *   GET   /v1/system/cash/:chain      — single-chain cash (agent, dashboard)
 *   PATCH /v1/system/cash             — set cash for a chain @Audited (agent)
 *   GET   /v1/system/gas?chain=       — gas balance for a chain (agent, dashboard)
 *
 * Two GET shapes handle the legacy get-cash parity:
 *   get-cash (no arg)    → GET /v1/system/cash        → CashBreakdownDto
 *   get-cash --chain X   → GET /v1/system/cash/:chain → CashByChainDto
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system')
export class CashController {
  constructor(private readonly svc: SystemService) {}

  @Get('cash')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get cash balances for all chains' })
  @ApiResponse({ status: 200, description: 'Flat cash breakdown: { [chain]: amount, total }' })
  getAllCash(): Promise<CashBreakdownDto> {
    return this.svc.getAllCash();
  }

  @Get('cash/:chain')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiOperation({ summary: 'Get cash balance for a specific chain' })
  @ApiResponse({ status: 200, description: 'Chain cash: { chain, cash }' })
  getCashByChain(@Param('chain') chain: string): Promise<CashByChainDto> {
    return this.svc.getCashByChain(chain);
  }

  @Patch('cash')
  @Roles('agent')
  @Identities('EXECUTOR', 'RESEARCH', 'LOOP')
  @Audited()
  @ApiOperation({ summary: 'Set cash balance for a chain' })
  @ApiResponse({ status: 200, description: 'Cash updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  setCash(@Body() dto: SetCashDto): Promise<{ ok: boolean; chain: string; cash: number }> {
    return this.svc.setCash(dto);
  }

  @Get('gas')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get gas token balance for a chain' })
  @ApiResponse({ status: 200, description: 'Gas info: { chain, symbol, balance, price, value_usd }' })
  @ApiResponse({ status: 400, description: 'Missing chain param' })
  getGas(@Query() query: GasQueryDto): Promise<GasResponseDto> {
    return this.svc.getGas(query.chain);
  }
}
