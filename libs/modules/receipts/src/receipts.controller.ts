import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth, ApiParam } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { ReceiptsService } from './receipts.service.js';
import { CreateReceiptDto } from './dto/create-receipt.dto.js';
import { ReceiptListQueryDto } from './dto/receipt-list-query.dto.js';
import type { ReceiptListResponseDto, ReceiptResponseDto } from './dto/receipt-response.dto.js';

/**
 * Receipts controller — HTTP surface for the receipts module (SPEC §5).
 *
 * Routes:
 *   GET  /v1/receipts         - list (agent + dashboard); ?mode=real|paper
 *   GET  /v1/receipts/:id     - get by id (agent + dashboard); ?mode=real|paper
 *   POST /v1/receipts         - create (agent only) @Audited
 *
 * Every handler has @Roles(…) (SPEC §4 #3).
 * Every non-GET handler has @Audited() (SPEC §9.5, ADR-0018).
 */
@ApiTags('receipts')
@ApiBearerAuth()
@Controller('receipts')
export class ReceiptsController {
  constructor(private readonly svc: ReceiptsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List receipts' })
  @ApiResponse({ status: 200, description: 'List of receipts' })
  list(@Query() query: ReceiptListQueryDto): Promise<ReceiptListResponseDto> {
    return this.svc.list(query);
  }

  @Get(':id')
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'Get a receipt by ID' })
  @ApiParam({ name: 'id', description: 'Receipt ID' })
  @ApiResponse({ status: 200, description: 'Receipt found' })
  @ApiResponse({ status: 404, description: 'Receipt not found' })
  getById(@Param('id') id: string, @Query('mode') mode?: 'real' | 'paper'): Promise<ReceiptResponseDto> {
    return this.svc.getById(id, mode ?? 'real');
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a receipt (executor writes execution records)' })
  @ApiResponse({ status: 201, description: 'Receipt created' })
  @ApiResponse({ status: 400, description: 'Validation error' })
  create(@Body() dto: CreateReceiptDto): Promise<ReceiptResponseDto> {
    return this.svc.create(dto);
  }
}
