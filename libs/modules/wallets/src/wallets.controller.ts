import { Controller, Get, Post, Patch, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam, ApiQuery } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { WalletsService } from './wallets.service.js';
import { AddTrackedWalletDto } from './dto/add-tracked-wallet.dto.js';
import { ProposeWalletDto } from './dto/propose-wallet.dto.js';
import { UpdateWalletScoreDto } from './dto/update-wallet-score.dto.js';
import { TrackedWalletsQueryDto } from './dto/tracked-wallets-query.dto.js';
import type { TrackedWalletResponseDto } from './dto/tracked-wallet-response.dto.js';

/**
 * Wallets controller — HTTP surface for tracked_wallets (SPEC §7).
 *
 * Routes:
 *   GET    /v1/wallets                        — list tracked wallets (agent, dashboard)
 *   GET    /v1/wallets/unscored               — list unscored wallets (agent)
 *   GET    /v1/wallets/:address/:chain        — get single wallet (agent, dashboard)
 *   POST   /v1/wallets                        — add/upsert wallet @Audited (agent)
 *   POST   /v1/wallets/propose                — propose wallet @Audited (agent)
 *   PATCH  /v1/wallets/:address/:chain/score  — update score @Audited (agent)
 *   DELETE /v1/wallets/:address/:chain        — remove wallet @Audited (agent)
 *
 * Note: /v1/wallets/signals is on SignalsController (same NestJS module).
 * Note: /v1/wallets/unscored and /v1/wallets/propose are registered BEFORE
 *       /:address/:chain so Fastify's router resolves them as static paths.
 *
 * Every handler has @Roles(…). Every non-GET has @Audited().
 */
@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets')
export class WalletsController {
  constructor(private readonly svc: WalletsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'List tracked wallets' })
  @ApiResponse({ status: 200, description: 'List of tracked wallets' })
  list(@Query() query: TrackedWalletsQueryDto): Promise<TrackedWalletResponseDto[]> {
    return this.svc.list(query);
  }

  @Get('unscored')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @ApiOperation({ summary: 'List wallets pending scoring (proposed or failed with retry_count < 3)' })
  @ApiQuery({ name: 'limit', required: false, description: 'Max rows (default 5)' })
  @ApiResponse({ status: 200, description: 'Unscored wallet list' })
  listUnscored(@Query('limit') limit?: string): Promise<TrackedWalletResponseDto[]> {
    return this.svc.listUnscored(limit != null ? parseInt(limit, 10) : undefined);
  }

  @Get(':address/:chain')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get a tracked wallet by address and chain' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiResponse({ status: 200, description: 'Tracked wallet' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  getOne(@Param('address') address: string, @Param('chain') chain: string): Promise<TrackedWalletResponseDto> {
    return this.svc.getOne(address, chain);
  }

  @Post()
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add or replace a tracked wallet (INSERT OR REPLACE)' })
  @ApiResponse({ status: 201, description: 'Wallet upserted' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  add(@Body() dto: AddTrackedWalletDto): Promise<TrackedWalletResponseDto> {
    return this.svc.add(dto);
  }

  @Post('propose')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Propose a wallet for scoring (INSERT OR IGNORE)' })
  @ApiResponse({ status: 201, description: 'Wallet proposed (or already exists — no-op)' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  propose(@Body() dto: ProposeWalletDto): Promise<{ ok: boolean; address: string; status: string; source: string }> {
    return this.svc.propose(dto);
  }

  @Patch(':address/:chain/score')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update wallet score and status' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiResponse({ status: 200, description: 'Score updated' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  updateScore(
    @Param('address') address: string,
    @Param('chain') chain: string,
    @Body() dto: UpdateWalletScoreDto,
  ): Promise<TrackedWalletResponseDto> {
    return this.svc.updateScore(address, chain, dto);
  }

  @Delete(':address/:chain')
  @Roles('agent')
  @Identities('RESEARCH', 'LOOP')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a tracked wallet' })
  @ApiParam({ name: 'address', description: 'Wallet address' })
  @ApiParam({ name: 'chain', description: 'Chain identifier' })
  @ApiResponse({ status: 200, description: 'Wallet removed' })
  @ApiResponse({ status: 404, description: 'Wallet not found' })
  remove(@Param('address') address: string, @Param('chain') chain: string): Promise<{ ok: boolean }> {
    return this.svc.remove(address, chain);
  }
}
