import { Controller, Post, Body, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { SystemService } from '../system.service.js';
import { SyncPortfolioDto } from '../dto/sync-portfolio.dto.js';
import type { SyncPortfolioEnqueuedResponseDto, SyncPortfolioPaperResponseDto } from '../dto/sync-portfolio.dto.js';

/**
 * Sync-portfolio controller — enqueues a position-reconcile BullMQ job.
 *
 * Routes:
 *   POST /v1/system/sync-portfolio  — fire-and-forget enqueue (agent only, audited)
 *
 * Returns HTTP 202 always:
 *   - Paper mode: { ok: false, message: '...' }
 *   - Real mode: { ok: true, queued: true, jobId: string }
 *
 * Mirrors legacy db-query.js `sync-portfolio --chain X [--trigger T]`
 * (lines 2003-2026), but changed from synchronous-blocking to fire-and-forget
 * per P5b plan key decision §4.
 *
 * DoD §C: every non-GET handler carries @Audited().
 * DoD §E: idempotency is enforced in PositionReconcileProcessor (shouldAppendDriftMarker
 *   prevents duplicate drift markers within the same UTC hour).
 */
@ApiTags('system')
@ApiBearerAuth()
@Controller('system/sync-portfolio')
export class SyncPortfolioController {
  constructor(private readonly svc: SystemService) {}

  @Post()
  @Roles('agent')
  @Identities('RESEARCH', 'EXECUTOR', 'LOOP')
  @Audited()
  @HttpCode(202)
  @ApiOperation({ summary: 'Enqueue a portfolio reconcile job (fire-and-forget)' })
  @ApiResponse({ status: 202, description: 'Job enqueued (real mode) or skipped (paper mode)' })
  @ApiResponse({ status: 400, description: 'Validation error — missing chain or invalid trigger' })
  @ApiResponse({ status: 401, description: 'Unauthorized' })
  @ApiResponse({ status: 403, description: 'Forbidden — dashboard role cannot enqueue jobs' })
  syncPortfolio(
    @Body() dto: SyncPortfolioDto,
  ): Promise<SyncPortfolioEnqueuedResponseDto | SyncPortfolioPaperResponseDto> {
    return this.svc.enqueueSyncPortfolio(dto);
  }
}
