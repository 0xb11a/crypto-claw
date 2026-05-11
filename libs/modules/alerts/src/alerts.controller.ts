import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AlertsService } from './alerts.service.js';
import { CreateAlertDto } from './dto/create-alert.dto.js';
import { AcknowledgeAlertDto } from './dto/acknowledge-alert.dto.js';
import { AlertListQueryDto } from './dto/alert-list-query.dto.js';
import type { AlertListResponseDto, AlertResponseDto } from './dto/alert-response.dto.js';

/**
 * Alerts controller — HTTP surface for the sentinel_alerts module (SPEC §5).
 *
 * Routes:
 *   GET  /v1/alerts                       - list (agent + dashboard); ?unprocessed=true
 *   GET  /v1/alerts/:id                   - get by id (agent + dashboard)
 *   POST /v1/alerts                       - create (agent only) @Audited
 *   POST /v1/alerts/:id/acknowledge       - acknowledge (agent + dashboard) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 */
@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List sentinel alerts' })
  @ApiResponse({ status: 200, description: 'List of alerts' })
  list(@Query() query: AlertListQueryDto): Promise<AlertListResponseDto> {
    return this.svc.list(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a sentinel alert by ID' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert found' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  getById(@Param('id') id: string): Promise<AlertResponseDto> {
    return this.svc.getById(id);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a sentinel alert' })
  @ApiResponse({ status: 201, description: 'Alert created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(@Body() dto: CreateAlertDto): Promise<AlertResponseDto> {
    return this.svc.create(dto);
  }

  @Post(':id/acknowledge')
  @Roles('agent', 'dashboard')
  @Audited()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Acknowledge a sentinel alert (idempotent)' })
  @ApiParam({ name: 'id', description: 'Alert ID' })
  @ApiResponse({ status: 200, description: 'Alert acknowledged (or already acknowledged — idempotent)' })
  @ApiResponse({ status: 404, description: 'Alert not found' })
  acknowledge(@Param('id') id: string, @Body() dto: AcknowledgeAlertDto): Promise<AlertResponseDto> {
    return this.svc.acknowledge(id, dto);
  }
}
