import { Controller, Get, Post, Patch, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { WatchlistService } from './watchlist.service.js';
import { AddWatchlistDto } from './dto/add-watchlist.dto.js';
import { UpdateWatchlistDto } from './dto/update-watchlist.dto.js';
import { WatchlistQueryDto } from './dto/watchlist-query.dto.js';
import type { WatchlistResponseDto } from './dto/watchlist-response.dto.js';

/**
 * Watchlist controller — HTTP surface for the watchlist table (SPEC §7).
 *
 * Routes:
 *   GET    /v1/watchlist       — list entries (agent, dashboard)
 *   GET    /v1/watchlist/:id   — get by ID (agent, dashboard)
 *   POST   /v1/watchlist       — add entry @Audited (agent)
 *   PATCH  /v1/watchlist/:id   — update entry @Audited (agent)
 *   DELETE /v1/watchlist/:id   — soft-delete @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET has @Audited().
 */
@ApiTags('watchlist')
@ApiBearerAuth()
@Controller('watchlist')
export class WatchlistController {
  constructor(private readonly svc: WatchlistService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List watchlist entries' })
  @ApiResponse({ status: 200, description: 'List of watchlist entries' })
  list(@Query() query: WatchlistQueryDto): Promise<WatchlistResponseDto[]> {
    return this.svc.list(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a watchlist entry by ID' })
  @ApiParam({ name: 'id', description: 'Watchlist entry ID' })
  @ApiResponse({ status: 200, description: 'Watchlist entry' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  getById(@Param('id') id: string): Promise<WatchlistResponseDto> {
    return this.svc.getById(id);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a token to the watchlist' })
  @ApiResponse({ status: 201, description: 'Entry created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  add(@Body() dto: AddWatchlistDto): Promise<WatchlistResponseDto> {
    return this.svc.add(dto);
  }

  @Patch(':id')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a watchlist entry' })
  @ApiParam({ name: 'id', description: 'Watchlist entry ID' })
  @ApiResponse({ status: 200, description: 'Entry updated' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  update(@Param('id') id: string, @Body() dto: UpdateWatchlistDto): Promise<WatchlistResponseDto> {
    return this.svc.update(id, dto);
  }

  @Delete(':id')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Soft-delete a watchlist entry (sets status=removed)' })
  @ApiParam({ name: 'id', description: 'Watchlist entry ID' })
  @ApiResponse({ status: 200, description: 'Entry removed (status=removed)' })
  @ApiResponse({ status: 404, description: 'Entry not found' })
  remove(@Param('id') id: string): Promise<{ ok: boolean; id: string }> {
    return this.svc.softDelete(id);
  }
}
