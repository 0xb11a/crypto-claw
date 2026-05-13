import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus, ParseIntPipe } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AgentLogsService } from '../agent-logs.service.js';
import { AppendResearchLogDto } from '../dto/append-research-log.dto.js';
import { AgentLogQueryDto } from '../dto/agent-log-query.dto.js';
import type { ResearchLogResponseDto } from '../dto/research-log-response.dto.js';

/**
 * Research log controller — HTTP surface for the research_log table (SPEC §7).
 *
 * Routes:
 *   GET  /v1/logs/research        — list recent rows (agent, dashboard)
 *   GET  /v1/logs/research/:id    — get single row (agent, dashboard)
 *   POST /v1/logs/research        — append row @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('agent-logs')
@ApiBearerAuth()
@Controller('logs/research')
export class ResearchLogController {
  constructor(private readonly svc: AgentLogsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List recent research log rows' })
  @ApiResponse({ status: 200, description: 'Research log list' })
  list(@Query() query: AgentLogQueryDto): Promise<ResearchLogResponseDto[]> {
    return this.svc.listResearch(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a research log row by ID' })
  @ApiParam({ name: 'id', description: 'Row integer ID' })
  @ApiResponse({ status: 200, description: 'Research log row' })
  @ApiResponse({ status: 404, description: 'Row not found' })
  getById(@Param('id', ParseIntPipe) id: number): Promise<ResearchLogResponseDto> {
    return this.svc.getResearchById(id);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append a research log row' })
  @ApiResponse({ status: 201, description: 'Row appended' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  append(@Body() dto: AppendResearchLogDto): Promise<ResearchLogResponseDto> {
    return this.svc.appendResearch(dto);
  }
}
