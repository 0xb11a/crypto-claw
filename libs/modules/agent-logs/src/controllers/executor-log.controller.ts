import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AgentLogsService } from '../agent-logs.service.js';
import { AppendExecutorLogDto } from '../dto/append-executor-log.dto.js';
import { AgentLogQueryDto } from '../dto/agent-log-query.dto.js';
import { StrictParseIntPipe } from '../pipes/strict-parse-int.pipe.js';
import type { ExecutorLogResponseDto } from '../dto/executor-log-response.dto.js';

/**
 * Executor log controller — HTTP surface for the executor_log table (SPEC §7).
 *
 * Routes:
 *   GET  /v1/logs/executor        — list recent rows (agent, dashboard)
 *   GET  /v1/logs/executor/:id    — get single row (agent, dashboard)
 *   POST /v1/logs/executor        — append row @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('agent-logs')
@ApiBearerAuth()
@Controller('logs/executor')
export class ExecutorLogController {
  constructor(private readonly svc: AgentLogsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List recent executor log rows' })
  @ApiResponse({ status: 200, description: 'Executor log list' })
  list(@Query() query: AgentLogQueryDto): Promise<ExecutorLogResponseDto[]> {
    return this.svc.listExecutor(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get an executor log row by ID' })
  @ApiParam({ name: 'id', description: 'Row integer ID' })
  @ApiResponse({ status: 200, description: 'Executor log row' })
  @ApiResponse({ status: 404, description: 'Row not found' })
  getById(@Param('id', StrictParseIntPipe) id: number): Promise<ExecutorLogResponseDto> {
    return this.svc.getExecutorById(id);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Append an executor log row' })
  @ApiResponse({ status: 201, description: 'Row appended' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  append(@Body() dto: AppendExecutorLogDto): Promise<ExecutorLogResponseDto> {
    return this.svc.appendExecutor(dto);
  }
}
