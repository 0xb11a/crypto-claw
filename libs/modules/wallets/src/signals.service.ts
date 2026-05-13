import { Injectable } from '@nestjs/common';
import { SignalsRepository } from './signals.repository.js';
import type { SignalsQueryDto } from './dto/signals-query.dto.js';
import type {
  SmartMoneySignalResponseDto,
  SmartMoneySignalGroupedResponseDto,
} from './dto/smart-money-signal-response.dto.js';

/**
 * Signals service — thin delegation layer for smart_money_signals queries.
 */
@Injectable()
export class SignalsService {
  constructor(private readonly repo: SignalsRepository) {}

  getSignals(query: SignalsQueryDto): Promise<SmartMoneySignalResponseDto[] | SmartMoneySignalGroupedResponseDto[]> {
    return this.repo.getSignals(query);
  }
}
