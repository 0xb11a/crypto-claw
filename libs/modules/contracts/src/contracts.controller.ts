import { Controller, Get, Post, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles } from '@cclaw/auth';
import { Audited } from '@cclaw/audit';
import { ContractsService } from './contracts.service.js';
import { AddContractSnapshotDto } from './dto/add-contract-snapshot.dto.js';
import { ContractSnapshotQueryDto } from './dto/contract-snapshot-query.dto.js';
import type { ContractSnapshotResponseDto } from './dto/contract-snapshot-response.dto.js';

/**
 * Contracts controller — HTTP surface for the contract_snapshots table (SPEC §7).
 *
 * Routes:
 *   GET  /v1/contracts/snapshots?address&chain&limit — list recent snapshots (agent, dashboard)
 *   POST /v1/contracts/snapshots                     — add snapshot @Audited (agent)
 *
 * Every handler has @Roles(…). Every non-GET handler has @Audited().
 */
@ApiTags('contracts')
@ApiBearerAuth()
@Controller('contracts/snapshots')
export class ContractsController {
  constructor(private readonly svc: ContractsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @ApiOperation({ summary: 'List recent contract safety snapshots' })
  @ApiResponse({ status: 200, description: 'Contract snapshot list' })
  @ApiResponse({ status: 400, description: 'Missing or invalid query params' })
  list(@Query() query: ContractSnapshotQueryDto): Promise<ContractSnapshotResponseDto[]> {
    return this.svc.list(query);
  }

  @Post()
  @Roles('agent')
  @Audited()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Add a contract safety snapshot' })
  @ApiResponse({ status: 201, description: 'Snapshot added' })
  @ApiResponse({ status: 400, description: 'Validation error (e.g. json exceeds 65KB)' })
  add(@Body() dto: AddContractSnapshotDto): Promise<ContractSnapshotResponseDto> {
    return this.svc.add(dto);
  }
}
