import { Controller, Get, Patch, Query, Body } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { SystemService } from '../system.service.js';
import { MetaQueryDto } from '../dto/meta-query.dto.js';
import { SetMetaDto } from '../dto/set-meta.dto.js';
import type { MetaResponseDto } from '../dto/meta-response.dto.js';

/**
 * Meta controller — HTTP surface for portfolio_meta key/value store.
 *
 * Routes:
 *   GET   /v1/system/meta?key=   — get single meta key (agent, dashboard)
 *   PATCH /v1/system/meta        — set meta key/value @Audited (agent)
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/meta')
export class MetaController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a portfolio_meta key/value' })
  @ApiResponse({ status: 200, description: 'Meta key/value pair (value is null if key not found)' })
  @ApiResponse({ status: 400, description: 'Missing key query param' })
  getMeta(@Query() query: MetaQueryDto): Promise<MetaResponseDto> {
    return this.svc.getMeta(query.key);
  }

  @Patch()
  @Roles('agent')
  @Audited()
  @ApiOperation({ summary: 'Set a portfolio_meta key/value' })
  @ApiResponse({ status: 200, description: 'Meta key/value updated' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  setMeta(@Body() dto: SetMetaDto): Promise<{ ok: boolean; key: string; value: string }> {
    return this.svc.setMeta(dto);
  }
}
