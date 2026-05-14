import { Injectable } from '@nestjs/common';
import { SystemRepository } from './system.repository.js';
import type { SetMetaDto } from './dto/set-meta.dto.js';
import type { MetaResponseDto } from './dto/meta-response.dto.js';
import type { SetCashDto } from './dto/set-cash.dto.js';
import type { CashByChainDto } from './dto/cash-by-chain.dto.js';
import type { CashBreakdownDto } from './dto/cash-breakdown.dto.js';
import type { GasResponseDto } from './dto/gas-query.dto.js';
import type { SyncStatusQueryDto } from './dto/sync-status-query.dto.js';
import type { PortfolioSyncResponseDto } from './dto/portfolio-sync-response.dto.js';

/**
 * System service — thin orchestration layer for meta, cash, gas, and portfolio sync.
 */
@Injectable()
export class SystemService {
  constructor(private readonly repo: SystemRepository) {}

  getMeta(key: string): Promise<MetaResponseDto> {
    return this.repo.getMeta(key);
  }

  setMeta(dto: SetMetaDto): Promise<{ ok: boolean; key: string; value: string }> {
    return this.repo.setMeta(dto);
  }

  getCashByChain(chain: string): Promise<CashByChainDto> {
    return this.repo.getCashByChain(chain);
  }

  getAllCash(): Promise<CashBreakdownDto> {
    return this.repo.getAllCash();
  }

  setCash(dto: SetCashDto): Promise<{ ok: boolean; chain: string; cash: number }> {
    return this.repo.setCash(dto);
  }

  getGas(chain: string): Promise<GasResponseDto> {
    return this.repo.getGas(chain);
  }

  getSyncStatus(query: SyncStatusQueryDto): Promise<PortfolioSyncResponseDto[]> {
    return this.repo.getSyncStatus(query);
  }
}
