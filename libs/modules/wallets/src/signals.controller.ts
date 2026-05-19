import { Controller, Get, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBearerAuth } from '@nestjs/swagger';
import { Roles, Identities } from '@cclaw/auth';
import { SignalsService } from './signals.service.js';
import { SignalsQueryDto } from './dto/signals-query.dto.js';
import type {
  SmartMoneySignalResponseDto,
  SmartMoneySignalGroupedResponseDto,
} from './dto/smart-money-signal-response.dto.js';

/**
 * Signals controller — HTTP surface for smart_money_signals (SPEC §7).
 *
 * Routes:
 *   GET /v1/wallets/signals — list signals with optional aggregation (agent, dashboard)
 *
 * No write endpoints: signals are produced exclusively by the legacy
 * activity-wallets-bg.js background loop (DoD §I — legacy untouched).
 *
 * Every handler has @Roles(…).
 */
@ApiTags('wallets')
@ApiBearerAuth()
@Controller('wallets/signals')
export class SignalsController {
  constructor(private readonly svc: SignalsService) {}

  @Get()
  @Roles('agent', 'dashboard')
  @Identities('*')
  @ApiOperation({
    summary:
      'Get smart-money signals (supports --since, --action, --chain, --group_by=token, --min_wallets, --tokens_in_positions)',
  })
  @ApiResponse({ status: 200, description: 'List of smart-money signals (ungrouped or aggregated by token)' })
  getSignals(
    @Query() query: SignalsQueryDto,
  ): Promise<SmartMoneySignalResponseDto[] | SmartMoneySignalGroupedResponseDto[]> {
    return this.svc.getSignals(query);
  }
}
