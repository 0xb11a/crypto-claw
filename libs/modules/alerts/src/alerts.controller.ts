import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { AlertsService } from './alerts.service.js';
import { CreateAlertDto } from './dto/create-alert.dto.js';
import { AcknowledgeAlertDto } from './dto/acknowledge-alert.dto.js';
import { AlertListQueryDto } from './dto/alert-list-query.dto.js';
import { SendAlertDto } from './dto/send-alert.dto.js';
import type { AlertListResponseDto, AlertResponseDto } from './dto/alert-response.dto.js';

/**
 * Alerts controller — HTTP surface for the sentinel_alerts module (SPEC §5).
 *
 * Routes:
 *   GET  /v1/alerts                       - list (agent + dashboard); ?unprocessed=true
 *   GET  /v1/alerts/:id                   - get by id (agent + dashboard)
 *   POST /v1/alerts                       - create (agent only) @Audited
 *   POST /v1/alerts/:id/acknowledge       - acknowledge (agent + dashboard) @Audited
 *   POST /v1/alerts/send                  - send Telegram notification (agent only) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 *
 * NOTE: /v1/alerts/send MUST be declared before /v1/alerts/:id so Fastify does
 * not match the literal "send" segment as an :id param.
 */
@ApiTags('alerts')
@ApiBearerAuth()
@Controller('alerts')
export class AlertsController {
  constructor(private readonly svc: AlertsService) {}

  /**
   * Send a Telegram notification via NotificationsService.
   *
   * Fire-and-forget — returns 202 before TG delivery completes.
   * TELEGRAM_BOT_TOKEN absent → silently dropped (no 5xx).
   *
   * Route declared BEFORE /:id so Fastify matches /send literally
   * and does not interpret it as a dynamic :id segment.
   *
   * ADR-0028 — agent-initiated Telegram alerts via cclaw.
   */
  @Post('send')
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Send a Telegram notification (fire-and-forget, 202)' })
  @ApiResponse({ status: 202, description: 'Alert accepted for delivery' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  @ApiResponse({ status: 403, description: 'Forbidden — agent role required' })
  send(@Body() dto: SendAlertDto): Promise<{ accepted: true }> {
    return this.svc.send(dto);
  }

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
