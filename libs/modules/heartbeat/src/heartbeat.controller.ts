import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { HeartbeatService } from './heartbeat.service.js';
import { PingHeartbeatDto } from './dto/ping-heartbeat.dto.js';
import { HeartbeatListQueryDto } from './dto/heartbeat-list-query.dto.js';
import type { HeartbeatResponseDto, OverdueChecksResponseDto } from './dto/heartbeat-response.dto.js';

/**
 * Heartbeat controller — HTTP surface for the heartbeat_state module (SPEC §5).
 *
 * Routes:
 *   GET  /v1/heartbeat                            - list all (agent + dashboard)
 *   GET  /v1/heartbeat/:agent                     - get by agent (agent + dashboard)
 *   GET  /v1/heartbeat/:agent/overdue             - get overdue checks (agent + dashboard)
 *   POST /v1/heartbeat/:agent/:checkType/ping     - update heartbeat (agent only) @Audited
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('heartbeat')
@ApiBearerAuth()
@Controller('heartbeat')
export class HeartbeatController {
  constructor(private readonly svc: HeartbeatService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List all heartbeat rows' })
  @ApiResponse({ status: 200, description: 'List of heartbeat rows' })
  list(@Query() query: HeartbeatListQueryDto): Promise<HeartbeatResponseDto[]> {
    return this.svc.list(query);
  }

  @Get(':agent/overdue')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get overdue checks for an agent' })
  @ApiParam({ name: 'agent', description: 'Agent name' })
  @ApiResponse({ status: 200, description: 'Overdue check status' })
  getOverdue(@Param('agent') agent: string): Promise<OverdueChecksResponseDto> {
    return this.svc.getOverdueChecks(agent);
  }

  @Get(':agent')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get heartbeat rows for a specific agent' })
  @ApiParam({ name: 'agent', description: 'Agent name' })
  @ApiResponse({ status: 200, description: 'Agent heartbeat rows' })
  @ApiResponse({ status: 404, description: 'Agent not found' })
  getByAgent(@Param('agent') agent: string): Promise<HeartbeatResponseDto[]> {
    return this.svc.getByAgent(agent);
  }

  @Post(':agent/:checkType/ping')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Ping (update) a heartbeat check' })
  @ApiParam({ name: 'agent', description: 'Agent name' })
  @ApiParam({ name: 'checkType', description: 'Check type (e.g. price_check, process_orders)' })
  @ApiResponse({ status: 200, description: 'Heartbeat updated' })
  ping(
    @Param('agent') agent: string,
    @Param('checkType') checkType: string,
    @Body() _dto: PingHeartbeatDto,
  ): Promise<HeartbeatResponseDto> {
    return this.svc.ping(agent, checkType);
  }
}
