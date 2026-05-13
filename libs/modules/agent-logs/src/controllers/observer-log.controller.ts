import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AgentLogsService } from '../agent-logs.service.js';
import { AppendObserverLogDto } from '../dto/append-observer-log.dto.js';
import { AgentLogQueryDto } from '../dto/agent-log-query.dto.js';
import type { ObserverLogResponseDto } from '../dto/observer-log-response.dto.js';

/**
 * Observer log controller — HTTP surface for the observer_log table (SPEC §7).
 *
 * Routes:
 *   GET  /v1/logs/observer        — list recent rows (agent, dashboard)
 *   GET  /v1/logs/observer/:id    — get single row (agent, dashboard)
 *   POST /v1/logs/observer        — append row @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('agent-logs')
@ApiBearerAuth()
@Controller('logs/observer')
export class ObserverLogController {
  constructor(private readonly svc: AgentLogsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List recent observer log rows' })
  @ApiResponse({ status: 200, description: 'Observer log list' })
  list(@Query() query: AgentLogQueryDto): Promise<ObserverLogResponseDto[]> {
    return this.svc.listObserver(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get an observer log row by ID' })
  @ApiParam({ name: 'id', description: 'Row integer ID' })
  @ApiResponse({ status: 200, description: 'Observer log row' })
  @ApiResponse({ status: 404, description: 'Row not found' })
  getById(@Param('id', ParseIntPipe) id: number): Promise<ObserverLogResponseDto> {
    return this.svc.getObserverById(id);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append an observer log row' })
  @ApiResponse({ status: 201, description: 'Row appended' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  append(@Body() dto: AppendObserverLogDto): Promise<ObserverLogResponseDto> {
    return this.svc.appendObserver(dto);
  }
}
