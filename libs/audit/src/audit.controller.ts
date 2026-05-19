import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { AuditRepository } from './audit.repository.js';
import { AuditQueryDto } from './dto/audit-query.dto.js';
import type { AuditListResponseDto, ServiceAuditEntryDto } from './dto/audit-response.dto.js';

/**
 * Audit query controller — GET /v1/system/audit (SPEC §9.5, ADR-0018).
 *
 * Routes:
 *   GET /v1/system/audit       - list audit entries (agent + dashboard per OPEN-Q1)
 *   GET /v1/system/audit/:id   - get single entry (agent + dashboard)
 *
 * All handlers are GET-only; no @Audited() required (no state mutation).
 * Every handler has @Roles(…) (SPEC §4 #3).
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/audit')
export class AuditController {
  constructor(private readonly repo: AuditRepository) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Query audit log entries' })
  @ApiResponse({ status: 200, description: 'Paginated audit entries' })
  @ApiResponse({ status: 400, description: 'Invalid query parameters' })
  async list(@Query() query: AuditQueryDto): Promise<AuditListResponseDto> {
    const limit = Math.min(query.limit ?? 100, 1000);
    const [data, total] = await Promise.all([this.repo.findMany(query), this.repo.count(query)]);
    const lastId = data.length > 0 ? data[data.length - 1]?.id : undefined;
    return {
      data,
      pagination: { total, limit, cursor: lastId, hasMore: data.length === limit },
    };
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({ summary: 'Get a single audit entry by ID' })
  @ApiParam({ name: 'id', description: 'Audit entry ID' })
  @ApiResponse({ status: 200, description: 'Audit entry found' })
  @ApiResponse({ status: 404, description: 'Audit entry not found' })
  getById(@Param('id') id: string): Promise<ServiceAuditEntryDto> {
    return this.repo.findById(id);
  }
}
