import { Controller, Get, Post, Patch, Delete, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { PositionsService } from './positions.service.js';
import { CreatePositionDto } from './dto/create-position.dto.js';
import { UpdatePositionDto } from './dto/update-position.dto.js';
import { ClosePositionDto } from './dto/close-position.dto.js';
import { PositionListQueryDto } from './dto/position-list-query.dto.js';
import type { PositionListResponseDto, PositionResponseDto } from './dto/position-response.dto.js';

/**
 * Positions controller — HTTP surface for the positions module (SPEC §5).
 *
 * Routes:
 *   GET    /v1/positions          - list (agent + dashboard)
 *   GET    /v1/positions/:id      - get by id (agent + dashboard)
 *   POST   /v1/positions          - create (agent only) @Audited
 *   PATCH  /v1/positions/:id      - update (agent only) @Audited
 *   POST   /v1/positions/:id/close - close (agent only) @Audited
 *   DELETE /v1/positions/:id      - delete (agent only) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 */
@ApiTags('positions')
@ApiBearerAuth()
@Controller('positions')
export class PositionsController {
  constructor(private readonly svc: PositionsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List positions' })
  @ApiResponse({ status: 200, description: 'List of positions' })
  list(@Query() query: PositionListQueryDto): Promise<PositionListResponseDto> {
    return this.svc.list(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a position by ID' })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({ status: 200, description: 'Position found' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  getById(@Param('id') id: string, @Query('mode') mode?: 'real' | 'paper'): Promise<PositionResponseDto> {
    return this.svc.getById(id, mode ?? 'real');
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new position' })
  @ApiResponse({ status: 201, description: 'Position created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(@Body() dto: CreatePositionDto): Promise<PositionResponseDto> {
    return this.svc.create(dto);
  }

  @Patch(':id')
  @Roles('agent')
  @Audited()
  @ApiOperation({ summary: 'Update a position' })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({ status: 200, description: 'Position updated' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  update(
    @Param('id') id: string,
    @Body() dto: UpdatePositionDto,
    @Query('mode') mode?: 'real' | 'paper',
  ): Promise<PositionResponseDto> {
    return this.svc.update(id, dto, mode ?? 'real');
  }

  @Post(':id/close')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Close a position' })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({ status: 200, description: 'Position closed' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  close(
    @Param('id') id: string,
    @Body() dto: ClosePositionDto,
    @Query('mode') mode?: 'real' | 'paper',
  ): Promise<PositionResponseDto> {
    return this.svc.close(id, dto, mode ?? 'real');
  }

  @Delete(':id')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Delete a position' })
  @ApiParam({ name: 'id', description: 'Position ID' })
  @ApiResponse({ status: 204, description: 'Position deleted' })
  @ApiResponse({ status: 404, description: 'Position not found' })
  async delete(@Param('id') id: string, @Query('mode') mode?: 'real' | 'paper'): Promise<void> {
    await this.svc.delete(id, mode ?? 'real');
  }
}
