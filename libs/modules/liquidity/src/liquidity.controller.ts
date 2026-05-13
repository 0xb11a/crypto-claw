import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { LiquidityService } from './liquidity.service.js';
import { AddLiquiditySnapshotDto } from './dto/add-liquidity-snapshot.dto.js';
import { LiquidityQueryDto } from './dto/liquidity-query.dto.js';
import type { LiquiditySnapshotResponseDto } from './dto/liquidity-snapshot-response.dto.js';

/**
 * Liquidity controller — HTTP surface for liquidity_snapshots (SPEC §7).
 *
 * Routes:
 *   GET  /v1/liquidity  — list snapshots (agent, dashboard)
 *   POST /v1/liquidity  — add snapshot @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET has @Audited().
 */
@ApiTags('liquidity')
@ApiBearerAuth()
@Controller('liquidity')
export class LiquidityController {
  constructor(private readonly svc: LiquidityService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List liquidity snapshots' })
  @ApiResponse({ status: 200, description: 'List of liquidity snapshots' })
  list(@Query() query: LiquidityQueryDto): Promise<LiquiditySnapshotResponseDto[]> {
    return this.svc.list(query);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a liquidity snapshot' })
  @ApiResponse({ status: 201, description: 'Snapshot created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  add(@Body() dto: AddLiquiditySnapshotDto): Promise<{ ok: boolean }> {
    return this.svc.add(dto);
  }
}
